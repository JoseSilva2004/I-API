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

const STUCK_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

// Motor de cola con PostgreSQL SKIP LOCKED, Prioridad, Recuperación de Bloqueos y Enfriamiento Anti-Baneo
export class QueueWorker {
  private isRunning = false;
  private timer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private burstCounters = new Map<string, number>();

  start(): void {
    if (this.timer) return;
    console.log('[QueueWorker] Motor de cola iniciado (Modo Adaptativo + Recuperación de PROCESSING)');

    // Recuperar de inmediato cualquier mensaje que haya quedado en PROCESSING tras un reinicio abrupto
    this.recoverStuckMessages().catch((err) =>
      console.error('[QueueWorker] Error recuperando mensajes atascados al iniciar:', err)
    );

    this.timer = setInterval(() => {
      this.processNextBatch().catch((err) => console.error('[QueueWorker] Error en ciclo:', err));
    }, 1500);

    this.recoveryTimer = setInterval(() => {
      this.recoverStuckMessages().catch((err) =>
        console.error('[QueueWorker] Error en recuperación periódica:', err)
      );
    }, 60 * 1000);
  }

  // Detiene la cola y espera (hasta 20 s) a que termine el envío en curso para no dejarlo en PROCESSING
  async stop(maxWaitMs = 20000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    const deadline = Date.now() + maxWaitMs;
    while (this.isRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Devuelve a PENDING los mensajes que llevan más de 5 minutos atascados en PROCESSING
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

  private async processNextBatch(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Reclama atómicamente 1 mensaje listo para enviar, priorizando HIGH sobre NORMAL
      const claimed = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<QueuedMessageRow[]>(Prisma.sql`
          SELECT id, tenant_id, channel, priority, recipient, type, payload, attempts
          FROM message_queue
          WHERE status = 'PENDING'
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

      await this.dispatchMessage(claimed);
    } finally {
      this.isRunning = false;
    }
  }

  private async dispatchMessage(msg: QueuedMessageRow): Promise<void> {
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
      if (msg.channel === 'WHATSAPP') {
        const now = Date.now();
        const lastSent = tenant.lastWhatsappSentAt ? tenant.lastWhatsappSentAt.getTime() : 0;
        const elapsedSinceLast = now - lastSent;

        // Si el número estuvo en reposo (> 2 min), reinicia el contador de ráfaga
        if (lastSent === 0 || elapsedSinceLast >= env.idleThresholdMs) {
          this.burstCounters.set(msg.tenant_id, 0);
        }

        const currentBurst = this.burstCounters.get(msg.tenant_id) || 0;
        const maxBatchBeforeBreak = randomBetween(12, 15);

        // Micro-descanso humano: cada 12-15 mensajes consecutivos toma una pausa de 3 a 5 minutos
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
            `[QueueWorker] Pausa humana anti-baneo activada (${Math.round(coffeeBreakMs / 1000)}s) tras ${currentBurst} envíos.`
          );
          return;
        }

        // Si el número está en ráfaga (< 2 min desde el último envío), reprograma con Jitter 20-45s
        const minSafeWindow = randomBetween(env.burstDelayMinMs, env.burstDelayMaxMs);
        if (lastSent > 0 && elapsedSinceLast < env.idleThresholdMs && elapsedSinceLast < minSafeWindow) {
          const waitRemainingMs = minSafeWindow - elapsedSinceLast;
          const nextSchedule = new Date(now + waitRemainingMs);

          await prisma.messageQueue.update({
            where: { id: msg.id },
            data: {
              status: 'PENDING',
              lockedAt: null,
              attempts: { decrement: 1 },
              scheduledAt: nextSchedule
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

        console.log(`[QueueWorker] WhatsApp ENVIADO (id: ${msg.id}, priority: ${msg.priority})`);
        return;
      }

      if (msg.channel === 'TELEGRAM') {
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

        console.log(`[QueueWorker] Telegram ENVIADO (id: ${msg.id})`);
      }
    } catch (error) {
      const errMsg = (error as Error).message || 'Error desconocido';

      // Si la sesión de WhatsApp no está conectada aún, mantiene en PENDING sin gastar intentos de envío
      if (errMsg === 'SESSION_NOT_CONNECTED') {
        const retryAt = new Date(Date.now() + 20000);
        await prisma.messageQueue.update({
          where: { id: msg.id },
          data: {
            status: 'PENDING',
            lockedAt: null,
            attempts: { decrement: 1 },
            errorReason: 'Esperando conexión de sesión WhatsApp',
            scheduledAt: retryAt
          }
        });
        return;
      }

      // Si el número no existe en WhatsApp o alcanzó los 3 intentos, marca como FAILED definitivo
      const isPermanentError =
        errMsg.startsWith('INVALID_WHATSAPP_NUMBER') || errMsg.startsWith('INVALID_MEDIA_URL') || msg.attempts >= 3;
      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: {
          status: isPermanentError ? 'FAILED' : 'PENDING',
          lockedAt: null,
          errorReason: errMsg,
          scheduledAt: new Date(Date.now() + 30000)
        }
      });

      console.warn(`[QueueWorker] Fallo en mensaje ${msg.id} (intento ${msg.attempts}/3): ${errMsg}`);
    }
  }
}

export const queueWorker = new QueueWorker();
