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

// Motor de cola con PostgreSQL SKIP LOCKED, Prioridad y Enfriamiento Adaptativo Anti-Baneo
export class QueueWorker {
  private isRunning = false;
  private timer?: NodeJS.Timeout;

  start(): void {
    if (this.timer) return;
    console.log('[QueueWorker] Motor de cola iniciado (Modo Adaptativo: 3-4s libre / 20-45s ráfaga)');
    this.timer = setInterval(() => {
      this.processNextBatch().catch((err) => console.error('[QueueWorker] Error en ciclo:', err));
    }, 1500);
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
          data: { status: 'PROCESSING', attempts: { increment: 1 } }
        });

        return msg;
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
        data: { status: 'FAILED', errorReason: 'Proyecto inactivo o inexistente' }
      });
      return;
    }

    try {
      if (msg.channel === 'WHATSAPP') {
        const now = Date.now();
        const lastSent = tenant.lastWhatsappSentAt ? tenant.lastWhatsappSentAt.getTime() : 0;
        const elapsedSinceLast = now - lastSent;

        // Si el número está en ráfaga (< 2 min desde el último envío), reprograma con Jitter 20-45s
        const minSafeWindow = randomBetween(env.burstDelayMinMs, env.burstDelayMaxMs);
        if (lastSent > 0 && elapsedSinceLast < env.idleThresholdMs && elapsedSinceLast < minSafeWindow) {
          const waitRemainingMs = minSafeWindow - elapsedSinceLast;
          const nextSchedule = new Date(now + waitRemainingMs);

          await prisma.messageQueue.update({
            where: { id: msg.id },
            data: {
              status: 'PENDING',
              attempts: { decrement: 1 },
              scheduledAt: nextSchedule
            }
          });
          return;
        }

        const typingMs = randomBetween(env.fastTypingMinMs, env.fastTypingMaxMs);
        await whatsappAdapter.send({
          tenantId: msg.tenant_id,
          recipient: msg.recipient,
          type: msg.type,
          payload: msg.payload || {},
          simulateTypingMs: typingMs
        });

        const sentTime = new Date();
        await prisma.$transaction([
          prisma.messageQueue.update({
            where: { id: msg.id },
            data: { status: 'SENT', sentAt: sentTime, errorReason: null }
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
          tenantId: msg.tenant_id,
          recipient: msg.recipient,
          type: msg.type,
          payload: msg.payload || {}
        });

        await prisma.messageQueue.update({
          where: { id: msg.id },
          data: { status: 'SENT', sentAt: new Date(), errorReason: null }
        });

        console.log(`[QueueWorker] Telegram ENVIADO (id: ${msg.id})`);
      }
    } catch (error) {
      const errMsg = (error as Error).message || 'Error desconocido';

      // Si la sesión de WhatsApp no está conectada aún, mantiene en PENDING sin perder el mensaje
      if (errMsg === 'SESSION_NOT_CONNECTED') {
        const retryAt = new Date(Date.now() + 20000);
        await prisma.messageQueue.update({
          where: { id: msg.id },
          data: {
            status: 'PENDING',
            errorReason: 'Esperando conexión de sesión WhatsApp',
            scheduledAt: retryAt
          }
        });
        return;
      }

      // Si el número no existe en WhatsApp o superó 3 intentos, marca como FAILED definitivo
      const isPermanentError = errMsg.startsWith('INVALID_WHATSAPP_NUMBER') || msg.attempts >= 3;
      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: {
          status: isPermanentError ? 'FAILED' : 'PENDING',
          errorReason: errMsg,
          scheduledAt: new Date(Date.now() + 30000)
        }
      });

      console.warn(`[QueueWorker] Fallo en mensaje ${msg.id}: ${errMsg}`);
    }
  }
}

export const queueWorker = new QueueWorker();

