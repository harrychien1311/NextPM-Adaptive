import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { HttpError } from '../lib/http-error';
import { env } from '../config/env';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { message: `No route for ${req.method} ${req.originalUrl}` } });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: { message: error.message, details: error.details } });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: { message: 'A record with these unique values already exists' } });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ error: { message: 'Resource not found' } });
    }
  }
  // Always log server-side so production errors are visible in the platform's log viewer;
  // only the client-facing message is sanitized in production.
  console.error(error);
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  res.status(500).json({ error: { message: env.isProd ? 'Unexpected server error' : message } });
}
