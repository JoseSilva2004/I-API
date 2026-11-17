import dns from 'dns/promises';
import net from 'net';
import { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { requireApiKey } from '../../middlewares/auth.middleware.js';
import { cleanupWorker } from '../../workers/cleanup.worker.js';

interface SendMessageBody {
  channel?: string;
  priority?: string;
  recipient?: string;
  type?: string;
  payload?: {
    text?: string;
    caption?: string;
    mediaUrl?: string;
    mediaBase64?: string;
    fileName?: string;
    mimeType?: string;
    humanize?: boolean;
  };
}

const VALID_CHANNELS = new Set(['WHATSAPP', 'TELEGRAM']);
const VALID_PRIORITIES = new Set(['HIGH', 'NORMAL']);
const VALID_TYPES = new Set(['TEXT', 'DOCUMENT', 'IMAGE']);

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.')
    ) {
      return true;
    }
  }
  return false;
}

// Valida que mediaUrl sea HTTPS público y previene ataques SSRF hacia la red interna o contenedores
async function validateSafeMediaUrl(rawUrl: string): Promise<{ valid: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'mediaUrl no tiene un formato de URL válido' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'mediaUrl solo permite protocolo https://' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === 'iapi-db' ||
    hostname === 'iapi-postgres' ||
    hostname === 'iapi-server' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return { valid: false, reason: 'mediaUrl apunta a un host interno no permitido' };
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { valid: false, reason: 'mediaUrl no puede apuntar a direcciones IP privadas o locales' };
    }
    return { valid: true };
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return { valid: false, reason: 'mediaUrl resuelve a una dirección IP privada o interna bloqueada' };
      }
    }
  } catch {
    return { valid: false, reason: 'No se pudo resolver el dominio de mediaUrl' };
  }

  return { valid: true };
}

// Rutas para encolado asíncrono de mensajes, consulta de estado y purgado de datos
export async function messageRoutes(app: FastifyInstance): Promise<void> {
  // 1. Encolar mensaje o documento (Responde 202 Accepted en milisegundos)
  app.post('/api/v1/messages/send', { preHandler: [requireApiKey] }, async (request, reply) => {
    const body = request.body as SendMessageBody;

    if (!body?.recipient || !body?.payload || typeof body.payload !== 'object') {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'Los campos recipient y payload son obligatorios'
      });
    }

    const channel = (body.channel?.toUpperCase() || 'WHATSAPP') as 'WHATSAPP' | 'TELEGRAM';
    const priority = (body.priority?.toUpperCase() || 'NORMAL') as 'HIGH' | 'NORMAL';
    const type = (body.type?.toUpperCase() || 'TEXT') as 'TEXT' | 'DOCUMENT' | 'IMAGE';

    if (!VALID_CHANNELS.has(channel)) {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'Valor de channel inválido. Use WHATSAPP o TELEGRAM'
      });
    }

    if (!VALID_PRIORITIES.has(priority)) {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'Valor de priority inválido. Use HIGH o NORMAL'
      });
    }

    if (!VALID_TYPES.has(type)) {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'Valor de type inválido. Use TEXT, DOCUMENT o IMAGE'
      });
    }

    if (type === 'TEXT' && (!body.payload.text || !String(body.payload.text).trim())) {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'Para mensajes TEXT el campo payload.text es obligatorio'
      });
    }

    if (type === 'DOCUMENT' || type === 'IMAGE') {
      if (!body.payload.mediaBase64 && !body.payload.mediaUrl) {
        return reply.code(400).send({
          status: 400,
          success: false,
          message: `Para mensajes ${type} debe enviar payload.mediaBase64 o payload.mediaUrl`
        });
      }

      if (body.payload.mediaUrl) {
        const urlCheck = await validateSafeMediaUrl(body.payload.mediaUrl);
        if (!urlCheck.valid) {
          return reply.code(400).send({
            status: 400,
            success: false,
            message: urlCheck.reason
          });
        }
      }
    }

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

  // 3. Ejecutar limpieza manual de payloads enviados del proyecto autenticado (exige hoursOld >= 1)
  app.post('/api/v1/messages/cleanup', { preHandler: [requireApiKey] }, async (request, reply) => {
    const body = (request.body as { hoursOld?: number }) || {};
    const hoursOld = body.hoursOld !== undefined ? Number(body.hoursOld) : 24;

    if (Number.isNaN(hoursOld) || hoursOld < 1) {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'El parámetro hoursOld debe ser un número mayor o igual a 1'
      });
    }

    const purgedCount = await cleanupWorker.purgeOldPayloads(hoursOld, request.tenant!.id);

    return reply.code(200).send({
      status: 200,
      success: true,
      message: `Se limpió el contenido sensible de ${purgedCount} mensajes del proyecto`,
      purgedCount
    });
  });
}
