import crypto from 'crypto';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { hashApiKey, migrateLegacyApiKeys } from './middlewares/auth.middleware.js';
import { redactUrl } from './utils/message-format.js';
import { instanceRoutes } from './modules/instances/instances.routes.js';
import { messageRoutes } from './modules/messages/messages.routes.js';
import { whatsappAdapter } from './providers/whatsapp/baileys.adapter.js';
import { queueWorker } from './workers/queue.worker.js';
import { cleanupWorker } from './workers/cleanup.worker.js';

const app = Fastify({
  logger: {
    level: env.nodeEnv === 'production' ? 'info' : 'warn',
    serializers: {
      // La URL de la página del QR puede llevar ?apiKey= o ?token=: se ocultan antes de escribir el log
      req: (req: { method: string; url: string; ip?: string }) => ({
        method: req.method,
        url: redactUrl(req.url),
        remoteAddress: req.ip
      })
    }
  },
  // Detrás de nginx u otro proxy, toma la IP real del cliente (necesario para el límite de intentos)
  trustProxy: env.trustProxy,
  bodyLimit: 5 * 1024 * 1024 // Reducido a 5MB para prevenir caídas por agotamiento de memoria (OOM)
});

app.get('/health', async () => ({
  status: 200,
  service: 'I-API Omnicanal Gateway',
  uptime: process.uptime()
}));

// Crea un proyecto inicial con llave aleatoria en el primer arranque (o rota la llave insegura por defecto si existía)
async function ensureDefaultTenant(): Promise<void> {
  const insecureTenant = await prisma.tenant.findFirst({
    where: { apiKey: { in: ['iapi_default_key_2026', hashApiKey('iapi_default_key_2026')] } }
  });

  if (insecureTenant) {
    const rawApiKey = `iapi_${crypto.randomBytes(16).toString('hex')}`;
    await prisma.tenant.update({
      where: { id: insecureTenant.id },
      data: { apiKey: hashApiKey(rawApiKey) }
    });
    console.log('==============================================================');
    console.log('[I-API] Llave por defecto insegura reemplazada por llave aleatoria:');
    console.log(`  Proyecto: ${insecureTenant.name}`);
    console.log(`  API Key : ${rawApiKey}`);
    console.log(`  Panel QR: http://localhost:${env.port}/api/v1/instances/qr?apiKey=${rawApiKey}`);
    console.log('==============================================================');
    return;
  }

  const count = await prisma.tenant.count();
  if (count === 0) {
    const rawApiKey = `iapi_${crypto.randomBytes(16).toString('hex')}`;
    const defaultTenant = await prisma.tenant.create({
      data: {
        name: 'Proyecto Principal (Default)',
        apiKey: hashApiKey(rawApiKey)
      }
    });
    console.log('==============================================================');
    console.log('[I-API] Proyecto inicial creado automáticamente:');
    console.log(`  Nombre  : ${defaultTenant.name}`);
    console.log(`  API Key : ${rawApiKey}`);
    console.log(`  Panel QR: http://localhost:${env.port}/api/v1/instances/qr?apiKey=${rawApiKey}`);
    console.log('==============================================================');
  }
}

async function setupGracefulShutdown(): Promise<void> {
  const shutdown = async (signal: string) => {
    console.log(`[I-API] Señal ${signal} recibida. Cerrando workers y conexiones ordenadamente...`);
    cleanupWorker.stop();
    await queueWorker.stop();
    whatsappAdapter.shutdown();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function bootstrap(): Promise<void> {
  try {
    await prisma.$connect();
    await ensureDefaultTenant();
    const migratedKeys = await migrateLegacyApiKeys();
    if (migratedKeys > 0) {
      console.log(`[I-API] ${migratedKeys} API Key(s) en texto plano convertidas a hash SHA-256.`);
    }

    await app.register(instanceRoutes);
    await app.register(messageRoutes);

    await whatsappAdapter.restoreAllSessions();
    queueWorker.start();
    cleanupWorker.start();
    await setupGracefulShutdown();

    await app.listen({ port: env.port, host: '0.0.0.0' });
    console.log(`🚀 [I-API] Servidor escuchando en http://localhost:${env.port}`);
  } catch (err) {
    console.error('[I-API] Error fatal al iniciar:', err);
    process.exit(1);
  }
}

bootstrap();
