import { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { requireApiKey } from '../../middlewares/auth.middleware.js';
import { cleanupWorker } from '../../workers/cleanup.worker.js';

interface SendMessageBody {
  channel?: 'WHATSAPP' | 'TELEGRAM';
  priority?: 'HIGH' | 'NORMAL';
  recipient?: string;
  type?: 'TEXT' | 'DOCUMENT' | 'IMAGE';
  payload?: {
    text?: string;
    caption?: string;
    mediaUrl?: string;
    mediaBase64?: string;
    fileName?: string;
    mimeType?: string;
  };
}

// Rutas para encolado asíncrono de mensajes, consulta de estado y purgado de datos
export async function messageRoutes(app: FastifyInstance): Promise<void> {
  // 1. Encolar mensaje o documento (Responde 202 Accepted en milisegundos)
  app.post('/api/v1/messages/send', { preHandler: [requireApiKey] }, async (request, reply) => {
    const body = request.body as SendMessageBody;

    if (!body?.recipient || !body?.payload) {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'Los campos recipient y payload son obligatorios'
      });
    }

    const channel = (body.channel?.toUpperCase() || 'WHATSAPP') as 'WHATSAPP' | 'TELEGRAM';
    const priority = (body.priority?.toUpperCase() || 'NORMAL') as 'HIGH' | 'NORMAL';
    const type = (body.type?.toUpperCase() || 'TEXT') as 'TEXT' | 'DOCUMENT' | 'IMAGE';

    const queued = await prisma.messageQueue.create({
      data: {
        tenantId: request.tenant!.id,
        channel,
        priority,
        recipient: String(body.recipient).trim(),
        type,
        payload: body.payload,
        status: 'PENDING'
      }
    });

    return reply.code(202).send({
      status: 202,
      success: true,
      message: 'Mensaje encolado para despacho inteligente',
      data: {
        messageId: queued.id,
        channel: queued.channel,
        priority: queued.priority,
        status: queued.status,
        createdAt: queued.createdAt
      }
    });
  });

  // 2. Consultar el estado de un mensaje específico y estadísticas de la cola
  app.get('/api/v1/messages/:id', { preHandler: [requireApiKey] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const msg = await prisma.messageQueue.findFirst({
      where: { id, tenantId: request.tenant!.id },
      select: {
        id: true,
        channel: true,
        priority: true,
        recipient: true,
        type: true,
        status: true,
        attempts: true,
        errorReason: true,
        payload: true,
        scheduledAt: true,
        sentAt: true,
        createdAt: true
      }
    });

    if (!msg) {
      return reply.code(404).send({
        status: 404,
        success: false,
        message: 'Mensaje no encontrado'
      });
    }

    return reply.code(200).send({
      status: 200,
      success: true,
      data: {
        ...msg,
        payloadPurged: msg.payload === null
      }
    });
  });

  // 3. Ejecutar limpieza manual de payloads enviados (Para pruebas de auditoría y privacidad)
  app.post('/api/v1/messages/cleanup', { preHandler: [requireApiKey] }, async (request, reply) => {
    const body = (request.body as { hoursOld?: number }) || {};
    const hoursOld = body.hoursOld !== undefined ? Number(body.hoursOld) : 24;
    const purgedCount = await cleanupWorker.purgeOldPayloads(hoursOld);

    return reply.code(200).send({
      status: 200,
      success: true,
      message: `Se limpió el contenido sensible de ${purgedCount} mensajes enviados`,
      purgedCount
    });
  });
}

