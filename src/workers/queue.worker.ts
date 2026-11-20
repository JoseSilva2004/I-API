import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { MessagePayload } from '../providers/provider.interface.js';
import { telegramAdapter } from '../providers/telegram/telegram.adapter.js';
import { whatsappAdapter } from '../providers/whatsapp/baileys.adapter.js';

interface QueuedMessageRow {
  id: string;
  tenant_id: string;
  channel: 'WHATSAPP' | 'TELEGRAM';
  priority: 'HIGH' | 'NORMAL';
  recipient: string;
  type: 'TEXT' | 'DOCUMENT' | 'IMAGE';
  payload: MessagePayload | null;
  attempts: number;
}

const randomBetween = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const STUCK_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export class QueueWorker {
  private telegramTimer?: NodeJS.Timeout;
  private whatsappTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private isTelegramRunning = false;
  private isClaimingWhatsapp = false;
  private activeWhatsappTenants = new Set<string>();
  private burstCounters = new Map<string, number>();

  start(): void {
    if (this.telegramTimer || this.whatsappTimer) return;
    console.log('[QueueWorker] Motores desacoplados iniciados (Telegram Directo + WhatsApp Multi-Tenant)');

    this.recoverStuckMessages().catch((err) =>
      console.error('[QueueWorker] Error recuperando mensajes atascados al iniciar:', err)
    );

    this.telegramTimer = setInterval(() => {
      this.processTelegramBatch().catch((err) =>
        console.error('[QueueWorker:Telegram] Error en ciclo:', err)
      );
    }, 500);

    this.whatsappTimer = setInterval(() => {
      this.processWhatsappBatch().catch((err) =>
        console.error('[QueueWorker:WhatsApp] Error en ciclo:', err)
      );
    }, 1000);

    this.recoveryTimer = setInterval(() => {
      this.recoverStuckMessages().catch((err) =>
        console.error('[QueueWorker] Error en recuperación periódica:', err)
      );
    }, 60 * 1000);
  }

  async stop(maxWaitMs = 20000): Promise<void> {
    if (this.telegramTimer) {
      clearInterval(this.telegramTimer);
      this.telegramTimer = undefined;
    }
    if (this.whatsappTimer) {
      clearInterval(this.whatsappTimer);
      this.whatsappTimer = undefined;
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }

    const deadline = Date.now() + maxWaitMs;
    while ((this.isTelegramRunning || this.activeWhatsappTenants.size > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async recoverStuckMessages(): Promise<void> {
    const expiredLock = new Date(Date.now() - STUCK_LOCK_TIMEOUT_MS);
    const recovered = await prisma.messageQueue.updateMany({
      where: {
        status: 'PROCESSING',
        OR: [{ lockedAt: { lte: expiredLock } }, { lockedAt: null }]
      },
      data: {
        status: 'PENDING',
        lockedAt: null,
        errorReason: 'Recuperado automáticamente tras reinicio o timeout de procesamiento'
      }
    });

    if (recovered.count > 0) {
      console.warn(`[QueueWorker] Se recuperaron ${recovered.count} mensajes atascados en PROCESSING.`);
    }
  }

  private async processTelegramBatch(): Promise<void> {
    if (this.isTelegramRunning) return;
    this.isTelegramRunning = true;

    try {
      const claimed = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<QueuedMessageRow[]>(Prisma.sql`
          SELECT id, tenant_id, channel, priority, recipient, type, payload, attempts
          FROM message_queue
          WHERE channel = 'TELEGRAM'
            AND status = 'PENDING'
            AND scheduled_at <= NOW()
          ORDER BY
            CASE WHEN priority = 'HIGH' THEN 0 ELSE 1 END ASC,
            scheduled_at ASC,
            created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `);

        if (rows.length === 0) return null;

        const msg = rows[0];
        await tx.messageQueue.update({
          where: { id: msg.id },
          data: {
            status: 'PROCESSING',
            lockedAt: new Date(),
            attempts: { increment: 1 }
          }
        });

        return {
          ...msg,
          attempts: msg.attempts + 1
        };
      });

      if (!claimed) return;
      await this.dispatchTelegram(claimed);
    } finally {
      this.isTelegramRunning = false;
    }
  }

  private async dispatchTelegram(msg: QueuedMessageRow): Promise<void> {
    const tenant = await prisma.tenant.findUnique({ where: { id: msg.tenant_id } });
    if (!tenant || !tenant.isActive) {
      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: {
          status: 'FAILED',
          lockedAt: null,
          errorReason: 'Proyecto inactivo o inexistente'
        }
      });
      return;
    }

    try {
      await telegramAdapter.send({
        messageId: msg.id,
        tenantId: msg.tenant_id,
        recipient: msg.recipient,
        type: msg.type,
        payload: msg.payload || {}
      });

      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: { status: 'SENT', lockedAt: null, sentAt: new Date(), errorReason: null }
      });

      console.log(`[QueueWorker:Telegram] ENVIADO (id: ${msg.id})`);
    } catch (error) {
      const errMsg = (error as Error).message || 'Error desconocido';
      const isPermanent = msg.attempts >= 3;
      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: {
          status: isPermanent ? 'FAILED' : 'PENDING',
          lockedAt: null,
          errorReason: errMsg,
          scheduledAt: new Date(Date.now() + 30000)
        }
      });
      console.warn(`[QueueWorker:Telegram] Fallo en mensaje ${msg.id} (intento ${msg.attempts}/3): ${errMsg}`);
    }
  }

  private async processWhatsappBatch(): Promise<void> {
    if (this.isClaimingWhatsapp) return;
    this.isClaimingWhatsapp = true;
    let claimed: QueuedMessageRow | null = null;

    try {
      const busyTenants = Array.from(this.activeWhatsappTenants);

      claimed = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<QueuedMessageRow[]>(
          busyTenants.length > 0
            ? Prisma.sql`
                SELECT id, tenant_id, channel, priority, recipient, type, payload, attempts
                FROM message_queue
                WHERE channel = 'WHATSAPP'
                  AND status = 'PENDING'
                  AND scheduled_at <= NOW()
                  AND tenant_id NOT IN (${Prisma.join(busyTenants)})
                ORDER BY
                  CASE WHEN priority = 'HIGH' THEN 0 ELSE 1 END ASC,
                  scheduled_at ASC,
                  created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
              `
            : Prisma.sql`
                SELECT id, tenant_id, channel, priority, recipient, type, payload, attempts
                FROM message_queue
                WHERE channel = 'WHATSAPP'
                  AND status = 'PENDING'
                  AND scheduled_at <= NOW()
                ORDER BY
                  CASE WHEN priority = 'HIGH' THEN 0 ELSE 1 END ASC,
                  scheduled_at ASC,
                  created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
              `
        );

        if (rows.length === 0) return null;

        const msg = rows[0];
        await tx.messageQueue.update({
          where: { id: msg.id },
          data: {
            status: 'PROCESSING',
            lockedAt: new Date(),
            attempts: { increment: 1 }
          }
        });

        return {
          ...msg,
          attempts: msg.attempts + 1
        };
      });

      if (claimed) {
        this.activeWhatsappTenants.add(claimed.tenant_id);
      }
    } finally {
      this.isClaimingWhatsapp = false;
    }

    if (!claimed) return;

    this.dispatchWhatsapp(claimed).finally(() => {
      this.activeWhatsappTenants.delete(claimed!.tenant_id);
    });
  }

  private async dispatchWhatsapp(msg: QueuedMessageRow): Promise<void> {
    const tenant = await prisma.tenant.findUnique({ where: { id: msg.tenant_id } });
    if (!tenant || !tenant.isActive) {
      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: {
          status: 'FAILED',
          lockedAt: null,
          errorReason: 'Proyecto inactivo o inexistente'
        }
      });
      return;
    }

    try {
      const now = Date.now();
      const lastSent = tenant.lastWhatsappSentAt ? tenant.lastWhatsappSentAt.getTime() : 0;
      const elapsedSinceLast = now - lastSent;

      if (lastSent === 0 || elapsedSinceLast >= env.idleThresholdMs) {
        this.burstCounters.set(msg.tenant_id, 0);
      }

      const currentBurst = this.burstCounters.get(msg.tenant_id) || 0;
      const maxBatchBeforeBreak = randomBetween(12, 15);

      // Micro-descanso humano por tenant
      if (currentBurst >= maxBatchBeforeBreak) {
        const coffeeBreakMs = randomBetween(180000, 300000);
        this.burstCounters.set(msg.tenant_id, 0);
        await prisma.messageQueue.update({
          where: { id: msg.id },
          data: {
            status: 'PENDING',
            lockedAt: null,
            attempts: { decrement: 1 },
            scheduledAt: new Date(now + coffeeBreakMs)
          }
        });
        console.log(
          `[QueueWorker:WhatsApp] Pausa anti-baneo tenant ${msg.tenant_id} (${Math.round(coffeeBreakMs / 1000)}s) tras ${currentBurst} envíos.`
        );
        return;
      }

      // Enfriamiento de ráfaga con Jitter por tenant
      const minSafeWindow = randomBetween(env.burstDelayMinMs, env.burstDelayMaxMs);
      if (lastSent > 0 && elapsedSinceLast < env.idleThresholdMs && elapsedSinceLast < minSafeWindow) {
        const waitRemainingMs = minSafeWindow - elapsedSinceLast;
        await prisma.messageQueue.update({
          where: { id: msg.id },
          data: {
            status: 'PENDING',
            lockedAt: null,
            attempts: { decrement: 1 },
            scheduledAt: new Date(now + waitRemainingMs)
          }
        });
        return;
      }

      await whatsappAdapter.send({
        messageId: msg.id,
        tenantId: msg.tenant_id,
        recipient: msg.recipient,
        type: msg.type,
        payload: msg.payload || {}
      });

      this.burstCounters.set(msg.tenant_id, currentBurst + 1);

      const sentTime = new Date();
      await prisma.$transaction([
        prisma.messageQueue.update({
          where: { id: msg.id },
          data: { status: 'SENT', lockedAt: null, sentAt: sentTime, errorReason: null }
        }),
        prisma.tenant.update({
          where: { id: msg.tenant_id },
          data: { lastWhatsappSentAt: sentTime }
        })
      ]);

      console.log(`[QueueWorker:WhatsApp] ENVIADO (id: ${msg.id}, priority: ${msg.priority})`);
    } catch (error) {
      const errMsg = (error as Error).message || 'Error desconocido';

      if (errMsg === 'SESSION_NOT_CONNECTED') {
        await prisma.messageQueue.update({
          where: { id: msg.id },
          data: {
            status: 'PENDING',
            lockedAt: null,
            attempts: { decrement: 1 },
            errorReason: 'Esperando conexión de sesión WhatsApp',
            scheduledAt: new Date(Date.now() + 20000)
          }
        });
        return;
      }

      const isPermanentError =
        errMsg.startsWith('INVALID_WHATSAPP_NUMBER') ||
        errMsg.startsWith('INVALID_MEDIA_URL') ||
        msg.attempts >= 3;

      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: {
          status: isPermanentError ? 'FAILED' : 'PENDING',
          lockedAt: null,
          errorReason: errMsg,
          scheduledAt: new Date(Date.now() + 30000)
        }
      });

      console.warn(
        `[QueueWorker:WhatsApp] Fallo en mensaje ${msg.id} (intento ${msg.attempts}/3): ${errMsg}`
      );
    }
  }
}

export const queueWorker = new QueueWorker();
