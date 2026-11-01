import rateLimit, { Options } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Rate limiting for sensitive endpoints.
 *
 * NOTE: the default store is in-memory, i.e. per server process. On a single
 * long-running server (Render / Docker) this is effective. On serverless
 * platforms (Vercel) each instance has its own counters, so limits are weaker;
 * use a shared store (e.g. Redis) there if stricter guarantees are needed.
 */
const make = (options: Partial<Options>) => {
  if (!env.rateLimit.enabled) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please wait a few minutes and try again.' },
    ...options,
  });
};

/** All API traffic: generous ceiling to stop floods. */
export const apiLimiter = make({ windowMs: 60 * 1000, limit: 600 });

/** Login: 20 attempts per 15 minutes per IP (per-account lockout also applies). */
export const loginLimiter = make({ windowMs: 15 * 60 * 1000, limit: 20 });

/** Forgot password: 5 OTP emails per 15 minutes per IP. */
export const otpRequestLimiter = make({ windowMs: 15 * 60 * 1000, limit: 5 });

/** OTP verification / reset: 15 per 15 minutes per IP (per-code attempt limit also applies). */
export const otpVerifyLimiter = make({ windowMs: 15 * 60 * 1000, limit: 15 });

/** Token refresh. */
export const refreshLimiter = make({ windowMs: 15 * 60 * 1000, limit: 60 });

/** Bulk data export (super admin). */
export const exportLimiter = make({ windowMs: 60 * 60 * 1000, limit: 30 });

/** Bids: 10 per 10 seconds per signed-in user (API_DESIGN §11). Mount after authenticateToken. */
export const bidLimiter = make({
  windowMs: 10 * 1000,
  limit: 10,
  // always mounted after authenticateToken, so the user id is present
  keyGenerator: (req: Request) => (req as Request & { user?: { id: string } }).user?.id ?? 'anonymous',
  message: { success: false, code: 'TOO_MANY_BIDS', message: 'Too many bids. Please wait a moment.' },
});
