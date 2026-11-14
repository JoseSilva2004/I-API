import { PrismaClient } from '@prisma/client';

// Instancia única de Prisma para evitar agotar el pool de conexiones en PostgreSQL
export const prisma = new PrismaClient({
  log: ['error', 'warn']
});

