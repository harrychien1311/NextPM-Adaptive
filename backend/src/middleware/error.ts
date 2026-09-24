import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { HttpError } from '../lib/http-error';
import { env } from '../config/env';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { message: `No route for ${req.method} ${req.originalUrl}` } });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: { message: error.message, details: error.details } });
  }
  /**
   * An upload that is too large, or too many files, is the PM's business and not a server fault —
   * but multer reports it as an ordinary Error, which the sanitiser below turns into "Unexpected
   * server error". Someone dropping a 12 MB file was told nothing at all about why.
   */
  if (error instanceof MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'That file is larger than this upload allows — check the size limit shown on the upload box.'
        : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Too many files in one upload.'
          : `Upload rejected (${error.code})`;
    return res.status(400).json({ error: { message } });
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
