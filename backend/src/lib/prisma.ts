import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

export const prisma = new PrismaClient({
  log: env.isProd ? ['error', 'warn'] : ['warn', 'error'],
});
