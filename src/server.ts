import Fastify from 'fastify';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { instanceRoutes } from './modules/instances/instances.routes.js';
import { messageRoutes } from './modules/messages/messages.routes.js';
import { whatsappAdapter } from './providers/whatsapp/baileys.adapter.js';
import { queueWorker } from './workers/queue.worker.js';
import { cleanupWorker } from './workers/cleanup.worker.js';

const app = Fastify({
  logger: false,
  bodyLimit: 25 * 1024 * 1024 // Permite PDFs e imágenes en Base64 de hasta 25MB
});

app.get('/health', async () => ({
  status: 200,
  service: 'I-API Omnicanal Gateway',
  uptime: process.uptime()
}));

// Crea un proyecto por defecto en el primer arranque para facilitar pruebas inmediatas
async function ensureDefaultTenant(): Promise<void> {
  const count = await prisma.tenant.count();
  if (count === 0) {
    const defaultTenant = await prisma.tenant.create({
      data: {
        name: 'Proyecto Principal (Default)',
        apiKey: 'iapi_default_key_2026'
      }
    });
    console.log('==============================================================');
    console.log('[I-API] Proyecto inicial creado automáticamente:');
    console.log(`  Nombre  : ${defaultTenant.name}`);
    console.log(`  API Key : ${defaultTenant.apiKey}`);
    console.log(`  Panel QR: http://localhost:${env.port}/api/v1/instances/qr?apiKey=${defaultTenant.apiKey}`);
    console.log('==============================================================');
  }
}

async function bootstrap(): Promise<void> {
  try {
    await prisma.$connect();
    await ensureDefaultTenant();

    await app.register(instanceRoutes);
    await app.register(messageRoutes);

    await whatsappAdapter.restoreAllSessions();
    queueWorker.start();
    cleanupWorker.start();

    await app.listen({ port: env.port, host: '0.0.0.0' });
    console.log(`🚀 [I-API] Servidor escuchando en http://localhost:${env.port}`);
  } catch (err) {
    console.error('[I-API] Error fatal al iniciar:', err);
    process.exit(1);
  }
}

bootstrap();
