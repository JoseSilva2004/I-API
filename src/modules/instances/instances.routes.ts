import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../../config/prisma.js';
import {
  createQrViewToken,
  findTenantByApiKey,
  hashApiKey,
  requireAdminKey,
  requireApiKey,
  verifyQrViewToken
} from '../../middlewares/auth.middleware.js';
import { whatsappAdapter } from '../../providers/whatsapp/baileys.adapter.js';
import { telegramAdapter } from '../../providers/telegram/telegram.adapter.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Rutas para gestión de proyectos (Tenants) y vinculación de WhatsApp/Telegram
export async function instanceRoutes(app: FastifyInstance): Promise<void> {
  // 1. Crear un nuevo proyecto/cliente (Requiere x-admin-key)
  app.post('/api/v1/tenants', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const body = request.body as { name?: string; telegramBotToken?: string };
    const cleanName = body?.name?.trim();
    if (!cleanName) {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'El campo name es obligatorio'
      });
    }

    const rawApiKey = `iapi_${crypto.randomBytes(16).toString('hex')}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: cleanName,
        apiKey: hashApiKey(rawApiKey),
        telegramBotToken: body.telegramBotToken?.trim() || null
      }
    });

    telegramAdapter.invalidateCache(tenant.id);

    return reply.code(200).send({
      status: 200,
      success: true,
      message: 'Proyecto creado exitosamente. Guarde su apiKey en un lugar seguro, no se volverá a mostrar.',
      data: {
        id: tenant.id,
        name: tenant.name,
        apiKey: rawApiKey,
        isActive: tenant.isActive,
        hasTelegramBotToken: Boolean(tenant.telegramBotToken),
        createdAt: tenant.createdAt
      }
    });
  });

  // 2. Iniciar vinculación de WhatsApp (Devuelve QR en Base64 o Pairing Code de 8 dígitos)
  app.post('/api/v1/instances/connect', { preHandler: [requireApiKey] }, async (request, reply) => {
    const body = (request.body as { phoneNumber?: string }) || {};
    const tenantId = request.tenant!.id;

    const result = await whatsappAdapter.connectInstance(tenantId, body.phoneNumber);
    return reply.code(200).send({
      status: 200,
      success: true,
      project: request.tenant!.name,
      data: result
    });
  });

  // 2b. Desvincular el número de WhatsApp del proyecto (cierra sesión y borra credenciales)
  app.post('/api/v1/instances/logout', { preHandler: [requireApiKey] }, async (request, reply) => {
    const result = await whatsappAdapter.logout(request.tenant!.id);
    return reply.code(200).send({
      status: 200,
      success: true,
      project: request.tenant!.name,
      message: 'Número de WhatsApp desvinculado',
      data: result
    });
  });

  // 3. Consultar estado de conexión de los canales del proyecto
  app.get('/api/v1/instances/status', { preHandler: [requireApiKey] }, async (request, reply) => {
    const tenantId = request.tenant!.id;
    const [whatsapp, telegram] = await Promise.all([
      whatsappAdapter.getStatus(tenantId),
      telegramAdapter.getStatus(tenantId)
    ]);

    return reply.code(200).send({
      status: 200,
      success: true,
      project: request.tenant!.name,
      channels: { whatsapp, telegram }
    });
  });

  // 4. Vista rápida en navegador para escanear el QR usando token temporal firmado
  app.get('/api/v1/instances/qr', async (request, reply) => {
    const query = request.query as { apiKey?: string; token?: string; phone?: string };
    const headerApiKey = (request.headers['x-api-key'] as string | undefined)?.trim();

    // Si viene apiKey en la URL, validarla y redirigir a un token temporal (10 min) para ocultarla de la barra e historial
    if (query.apiKey) {
      const tenant = await findTenantByApiKey(query.apiKey.trim());
      if (!tenant) {
        return reply.code(401).send({ status: 401, message: 'API Key inválida' });
      }
      const token = createQrViewToken(tenant.id);
      const phoneParam = query.phone ? `&phone=${encodeURIComponent(query.phone.replace(/\D/g, ''))}` : '';
      return reply.redirect(`/api/v1/instances/qr?token=${encodeURIComponent(token)}${phoneParam}`);
    }

    let tenantId: string | null = null;
    if (query.token) {
      tenantId = verifyQrViewToken(query.token);
    } else if (headerApiKey) {
      const t = await findTenantByApiKey(headerApiKey);
      tenantId = t?.id || null;
    }

    if (!tenantId) {
      return reply.code(401).send({
        status: 401,
        message: 'Token expirado o API Key inválida. Pase header x-api-key o ?apiKey=SU_API_KEY'
      });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || !tenant.isActive) {
      return reply.code(401).send({ status: 401, message: 'Proyecto inactivo o inexistente' });
    }

    const res = await whatsappAdapter.connectInstance(tenant.id, query.phone);
    const safeName = escapeHtml(tenant.name);
    const safePairing = res.pairingCode ? escapeHtml(res.pairingCode) : '';

    reply.type('text/html; charset=utf-8');
    if (res.status === 'CONNECTED') {
      return `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2 style="color:#16a34a;">✅ WhatsApp Conectado (${safeName})</h2>
        <p>La sesión está activa y persistida en PostgreSQL.</p>
      </body></html>`;
    }

    return `<html><head><meta http-equiv="refresh" content="15"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f8fafc;">
        <h2>Vincular WhatsApp — ${safeName}</h2>
        ${
          res.qrBase64
            ? `<img src="${res.qrBase64}" style="width:280px;height:280px;border:8px solid white;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);"/>`
            : '<p>Generando QR, la página se actualizará sola...</p>'
        }
        ${
          safePairing
            ? `<h3>Código de 8 dígitos: <code style="background:#e2e8f0;padding:6px 12px;border-radius:6px;">${safePairing}</code></h3>`
            : ''
        }
        <p style="color:#64748b;">Esta página se actualiza automáticamente cada 15s.</p>
      </body></html>`;
  });
}
