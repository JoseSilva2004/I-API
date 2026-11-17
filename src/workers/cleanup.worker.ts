import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

// Worker de privacidad y ahorro de espacio: limpia el payload sensible tras 24h en SENT/FAILED y expira PENDING > 7 días
export class CleanupWorker {
  private timer?: NodeJS.Timeout;

  start(): void {
    if (this.timer) return;
    // Ejecuta cada 1 hora
    this.timer = setInterval(() => {
      this.purgeOldPayloads(24).catch((err) => console.error('[CleanupWorker] Error:', err));
    }, 60 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async purgeOldPayloads(hoursOld = 24, tenantId?: string): Promise<number> {
    const safeHours = Math.max(1, Number(hoursOld) || 24);
    const cutoff = new Date(Date.now() - safeHours * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const tenantFilter = tenantId ? { tenantId } : {};

    // 1. Marcar como FAILED y vaciar payload de mensajes PENDING atascados por más de 7 días
    const expiredPending = await prisma.messageQueue.updateMany({
      where: {
        ...tenantFilter,
        status: 'PENDING',
        createdAt: { lte: sevenDaysAgo }
      },
      data: {
        status: 'FAILED',
        errorReason: 'Expirado tras 7 días sin poder despacharse',
        payload: Prisma.DbNull
      }
    });

    // 2. Vaciar el payload sensible de mensajes SENT o FAILED antiguos (> hoursOld)
    const purged = await prisma.messageQueue.updateMany({
      where: {
        ...tenantFilter,
        payload: { not: Prisma.DbNull },
        OR: [
          { status: 'SENT', sentAt: { lte: cutoff } },
          { status: 'FAILED', createdAt: { lte: cutoff } }
        ]
      },
      data: {
        payload: Prisma.DbNull
      }
    });

    const total = expiredPending.count + purged.count;
    if (total > 0) {
      console.log(
        `[CleanupWorker] Contenido purgado en ${total} mensajes (> ${safeHours}h${tenantId ? `, tenant: ${tenantId}` : ''})`
      );
    }
    return total;
  }
}

export const cleanupWorker = new CleanupWorker();
