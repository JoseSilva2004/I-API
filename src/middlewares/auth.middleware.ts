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

// Middleware para autenticar proyectos mediante header x-api-key
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const apiKey = request.headers['x-api-key'] as string | undefined;

  if (!apiKey) {
    reply.code(401).send({
      status: 401,
      success: false,
      message: 'Falta el header x-api-key'
    });
    return;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { apiKey }
  });

  if (!tenant || !tenant.isActive) {
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

// Middleware administrativo para crear nuevos proyectos/clientes
export async function requireAdminKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const adminKey = request.headers['x-admin-key'] as string | undefined;
  if (!adminKey || adminKey !== env.adminMasterKey) {
    reply.code(401).send({
      status: 401,
      success: false,
      message: 'x-admin-key inválida'
    });
  }
}

