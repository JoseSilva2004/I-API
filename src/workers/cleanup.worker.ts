import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

// Worker de privacidad y ahorro de espacio: limpia el payload sensible tras 24h de enviado
export class CleanupWorker {
  private timer?: NodeJS.Timeout;

  start(): void {
    if (this.timer) return;
    // Ejecuta cada 1 hora
    this.timer = setInterval(() => {
      this.purgeOldPayloads(24).catch((err) => console.error('[CleanupWorker] Error:', err));
    }, 60 * 60 * 1000);
  }

  async purgeOldPayloads(hoursOld = 24): Promise<number> {
    const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
    const result = await prisma.messageQueue.updateMany({
      where: {
        status: 'SENT',
        sentAt: { lte: cutoff },
        NOT: { payload: Prisma.DbNull }
      },
      data: {
        payload: Prisma.DbNull
      }
    });

    if (result.count > 0) {
      console.log(`[CleanupWorker] Contenido purgado en ${result.count} mensajes enviados (> ${hoursOld}h)`);
    }
    return result.count;
  }
}

export const cleanupWorker = new CleanupWorker();

