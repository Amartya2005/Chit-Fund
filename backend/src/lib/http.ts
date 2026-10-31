import { Response } from 'express';
import { Prisma } from '@prisma/client';

/** An error whose message is safe to show to API clients. */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const forbidden = (message = 'Access denied') => new HttpError(403, message);
export const notFound = (message = 'Record not found') => new HttpError(404, message);

/**
 * Send an error response without leaking internals.
 *
 * Previously every handler returned `err.message` with status 500, which exposed
 * Prisma/database error text (table names, constraint names, query details).
 * Now only HttpError messages and a few well-known Prisma cases are returned;
 * everything else is logged server-side and reported generically.
 */
export function sendError(res: Response, err: unknown) {
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'A record with the same unique value already exists.' });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({ success: false, message: 'Referenced record does not exist or is still in use.' });
    }
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError && /\b(22021|22P02)\b/.test(err.message)) {
    // invalid byte sequence / invalid text representation in client-supplied input
    return res.status(400).json({ success: false, message: 'Invalid request data.' });
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    console.error('[API] Prisma validation error:', err.message.split('\n').slice(-3).join(' '));
    return res.status(400).json({ success: false, message: 'Invalid request data.' });
  }
  console.error('[API] Unhandled error:', err instanceof Error ? `${err.name}: ${err.message}` : err);
  return res.status(500).json({ success: false, message: 'Internal server error' });
}
