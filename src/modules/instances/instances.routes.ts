import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../../config/prisma.js';
import { requireAdminKey, requireApiKey } from '../../middlewares/auth.middleware.js';
import { whatsappAdapter } from '../../providers/whatsapp/baileys.adapter.js';
import { telegramAdapter } from '../../providers/telegram/telegram.adapter.js';

// Rutas para gestión de proyectos (Tenants) y vinculación de WhatsApp/Telegram
export async function instanceRoutes(app: FastifyInstance): Promise<void> {
  // 1. Crear un nuevo proyecto/cliente (Requiere x-admin-key)
  app.post('/api/v1/tenants', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const body = request.body as { name?: string; telegramBotToken?: string };
    if (!body?.name) {
      return reply.code(400).send({
        status: 400,
        success: false,
        message: 'El campo name es obligatorio'
      });
    }

    const apiKey = `iapi_${crypto.randomBytes(16).toString('hex')}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: body.name,
        apiKey,
        telegramBotToken: body.telegramBotToken || null
      }
    });

    return reply.code(200).send({
      status: 200,
      success: true,
      message: 'Proyecto creado exitosamente',
      data: tenant
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

  // 4. Vista rápida en navegador para escanear el QR fácilmente
  app.get('/api/v1/instances/qr', async (request, reply) => {
    const query = request.query as { apiKey?: string; phone?: string };
    if (!query.apiKey) {
      return reply.code(400).send({ status: 400, message: 'Pase ?apiKey=SU_API_KEY en la URL' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { apiKey: query.apiKey } });
    if (!tenant) {
      return reply.code(401).send({ status: 401, message: 'API Key inválida' });
    }

    const res = await whatsappAdapter.connectInstance(tenant.id, query.phone);

    reply.type('text/html; charset=utf-8');
    if (res.status === 'CONNECTED') {
      return `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2 style="color:#16a34a;">✅ WhatsApp Conectado (${tenant.name})</h2>
        <p>La sesión está activa y persistida en PostgreSQL.</p>
      </body></html>`;
    }

    return `<html><head><meta http-equiv="refresh" content="15"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f8fafc;">
        <h2>Vincular WhatsApp — ${tenant.name}</h2>
        ${res.qrBase64 ? `<img src="${res.qrBase64}" style="width:280px;height:280px;border:8px solid white;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);"/>` : '<p>Generando QR, recargue en 3 segundos...</p>'}
        ${res.pairingCode ? `<h3>Código de 8 dígitos: <code style="background:#e2e8f0;padding:6px 12px;border-radius:6px;">${res.pairingCode}</code></h3>` : ''}
        <p style="color:#64748b;">Esta página se actualiza automáticamente.</p>
      </body></html>`;
  });
}

