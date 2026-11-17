import crypto from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: {
      id: string;
      name: string;
      apiKey: string;
    };
  }
}

// Control de intentos fallidos por IP en memoria (protección contra fuerza bruta)
const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILED_ATTEMPTS = 15;
const WINDOW_MS = 60 * 1000;

function checkRateLimit(ip: string, reply: FastifyReply): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (entry && now < entry.resetAt && entry.count >= MAX_FAILED_ATTEMPTS) {
    reply.code(429).send({
      status: 429,
      success: false,
      message: 'Demasiados intentos de autenticación fallidos. Intente de nuevo en 1 minuto.'
    });
    return false;
  }
  return true;
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    failedAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export function hashApiKey(rawKey: string): string {
  return `sha256:${crypto.createHash('sha256').update(rawKey).digest('hex')}`;
}

// Solo compara contra el hash: el valor guardado en la base de datos nunca sirve como llave
export async function findTenantByApiKey(rawKey: string) {
  return prisma.tenant.findFirst({
    where: { isActive: true, apiKey: hashApiKey(rawKey) }
  });
}

// Convierte a hash las llaves que quedaron en texto plano de versiones anteriores (se ejecuta al arrancar)
export async function migrateLegacyApiKeys(): Promise<number> {
  const legacy = await prisma.tenant.findMany({
    where: { NOT: { apiKey: { startsWith: 'sha256:' } } },
    select: { id: true, apiKey: true }
  });
  for (const t of legacy) {
    await prisma.tenant.update({ where: { id: t.id }, data: { apiKey: hashApiKey(t.apiKey) } });
  }
  return legacy.length;
}

// Limpia del mapa las IPs cuya ventana ya venció para que no crezca indefinidamente
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failedAttempts) {
    if (now >= entry.resetAt) failedAttempts.delete(ip);
  }
}, WINDOW_MS).unref();

// Genera un token temporal firmado (10 min) para la vista del QR sin exponer la API Key en el historial/refresh
export function createQrViewToken(tenantId: string): string {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const payload = `${tenantId}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', env.adminMasterKey).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyQrViewToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [tenantId, expiresStr, sig] = parts;
  const expiresAt = Number(expiresStr);
  if (!tenantId || Number.isNaN(expiresAt) || Date.now() > expiresAt) return null;

  const expectedSig = crypto
    .createHmac('sha256', env.adminMasterKey)
    .update(`${tenantId}.${expiresAt}`)
    .digest('hex');

  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return tenantId;
}

// Middleware para autenticar proyectos mediante header x-api-key
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ip = request.ip || 'unknown';
  if (!checkRateLimit(ip, reply)) return;

  const apiKey = (request.headers['x-api-key'] as string | undefined)?.trim();

  if (!apiKey) {
    recordFailedAttempt(ip);
    reply.code(401).send({
      status: 401,
      success: false,
      message: 'Falta el header x-api-key'
    });
    return;
  }

  const tenant = await findTenantByApiKey(apiKey);

  if (!tenant) {
    recordFailedAttempt(ip);
    reply.code(401).send({
      status: 401,
      success: false,
      message: 'API Key inválida o proyecto inactivo'
    });
    return;
  }

  request.tenant = {
    id: tenant.id,
    name: tenant.name,
    apiKey: tenant.apiKey
  };
}

// Middleware administrativo en tiempo constante para crear nuevos proyectos/clientes
export async function requireAdminKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ip = request.ip || 'unknown';
  if (!checkRateLimit(ip, reply)) return;

  const adminKey = (request.headers['x-admin-key'] as string | undefined)?.trim() || '';
  const providedHash = crypto.createHash('sha256').update(adminKey).digest();
  const expectedHash = crypto.createHash('sha256').update(env.adminMasterKey).digest();

  if (!adminKey || !crypto.timingSafeEqual(providedHash, expectedHash)) {
    recordFailedAttempt(ip);
    reply.code(401).send({
      status: 401,
      success: false,
      message: 'x-admin-key inválida'
    });
  }
}
