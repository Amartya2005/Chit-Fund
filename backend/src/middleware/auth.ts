import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    companyId?: string | null;
    role: string;
    phone: string;
    fullName: string;
    sessionId?: string;
  };
}

export const ROLES = ['SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'] as const;

/**
 * P7: subscribers with a member login. Not part of ROLES (the staff roles): generic user
 * management can neither create nor assign it; member logins are created per subscriber
 * (POST /engine/members/:subscriberId/login) and may only call the member API below.
 */
export const MEMBER_ROLE = 'MEMBER';
const MEMBER_PATHS = ['/auth/logout', '/auth/change-password', '/auth/me', '/me/member', '/engine/member'];
const memberPathAllowed = (path: string) => MEMBER_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Verifies the Bearer access token and loads the user from the database.
 *
 * Role and company are always taken from the database row, never from the token
 * payload or the request, so a client cannot change its own role/company.
 * The token must carry a sessionId that still exists (single active session /
 * revocation on logout, password change and suspension).
 */
export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  // Enforce tab-isolated Bearer header authorization to prevent cross-tab cookie bleeding
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication token required' });
  }

  let decoded: jwt.JwtPayload;
  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string') throw new Error('Unexpected token payload');
    decoded = payload;
  } catch {
    // Status 403 kept for compatibility with the existing mobile/web client.
    return res.status(403).json({ success: false, message: 'Invalid or expired authentication token' });
  }

  if (typeof decoded.userId !== 'string' || typeof decoded.sessionId !== 'string') {
    return res.status(403).json({ success: false, message: 'Invalid or expired authentication token' });
  }

  try {
    // Single active screen check: verify that this specific session has not been superseded or revoked
    const activeSession = await prisma.refreshToken.findUnique({
      where: { id: decoded.sessionId },
      select: { userId: true, expiresAt: true },
    });
    if (!activeSession || activeSession.userId !== decoded.userId || activeSession.expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_TERMINATED',
        message: 'This account was logged in from another screen. You have been logged out.',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        companyId: true,
        role: true,
        phone: true,
        fullName: true,
        status: true,
        company: {
          select: {
            id: true,
            status: true,
            memberPortalEnabled: true,
          },
        },
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, message: 'User account is inactive or disabled' });
    }

    if (!(ROLES as readonly string[]).includes(user.role) && user.role !== MEMBER_ROLE) {
      return res.status(403).json({ success: false, message: 'User account has an unknown role' });
    }
    if (user.role === MEMBER_ROLE) {
      if (!user.company?.memberPortalEnabled) {
        return res.status(403).json({ success: false, code: 'MEMBER_PORTAL_DISABLED', message: 'Member access is not enabled for this company.' });
      }
      if (!memberPathAllowed(req.path)) {
        return res.status(403).json({ success: false, code: 'MEMBER_SCOPE', message: 'Members can only use the member area.' });
      }
    }

    // Non super-admin accounts must belong to a company
    if (user.role !== 'SUPER_ADMIN' && !user.companyId) {
      return res.status(403).json({ success: false, message: 'User account is not linked to a company' });
    }

    // Block non-SUPER_ADMIN users if their company has been deleted
    if (
      user.role !== 'SUPER_ADMIN' &&
      user.company &&
      (user.company.status === 'DELETED' || user.company.status === 'deleted')
    ) {
      return res.status(403).json({
        success: false,
        message: 'This company account has been deleted. Access is revoked.',
      });
    }

    // FR-SA-014: Prohibit suspended companies from performing business write operations while preserving historical read access
    if (
      user.role !== 'SUPER_ADMIN' &&
      user.company &&
      user.company.status === 'SUSPENDED' &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      !req.path.endsWith('/auth/logout')
    ) {
      return res.status(403).json({
        success: false,
        message: 'Policy FR-SA-014 Enforced: Company account is currently suspended. Business operations are prohibited while historical records remain accessible.',
      });
    }

    req.user = {
      id: user.id,
      companyId: user.companyId,
      role: user.role,
      phone: user.phone,
      fullName: user.fullName,
      sessionId: decoded.sessionId,
    };

    next();
  } catch (err) {
    console.error('[Auth] Session verification failed:', err instanceof Error ? err.message : err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const requireRoles = (...allowedRoles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Requires one of roles: ${allowedRoles.join(', ')}`,
      });
    }

    next();
  };
};
