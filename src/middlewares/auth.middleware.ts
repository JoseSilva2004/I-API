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

export async function findTenantByApiKey(rawKey: string) {
  const hashed = hashApiKey(rawKey);
  const tenant = await prisma.tenant.findFirst({
    where: {
      isActive: true,
      OR: [{ apiKey: hashed }, { apiKey: rawKey }]
    }
  });
  return tenant;
}

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
