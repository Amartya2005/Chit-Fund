import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { sendError } from '../../lib/http.js';
import { env } from '../../config/env.js';
import { ROLES } from '../../middleware/auth.js';
import { isSuperAdmin, loadUserForTenant } from '../../security/tenant.js';
import { sendOtpEmail, sendAdminCredentialsEmail } from '../../services/email.service.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 10;

/**
 * OTPs are never stored or logged in plain text. The PASSWORD_RESET_OTP audit
 * record holds only an HMAC of the code (keyed with the server secret, so the
 * 6-digit space cannot be brute-forced offline from a database/audit-log read),
 * the expiry and the failed-attempt counter.
 */
const hashOtp = (userId: string, otp: string) =>
  crypto.createHmac('sha256', env.refreshTokenSecret).update(`${userId}:${otp}`).digest('hex');

const timingSafeEqualHex = (a: string, b: string) => {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

const signAccessToken = (user: { id: string; role: string; companyId: string | null }, sessionId: string) =>
  jwt.sign({ userId: user.id, sessionId, role: user.role, companyId: user.companyId }, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });

const findUserByIdentifier = (identifier: string) =>
  prisma.user.findFirst({
    where: {
      OR: [
        { username: { equals: identifier, mode: 'insensitive' } },
        { email: { equals: identifier, mode: 'insensitive' } },
        { phone: identifier },
      ],
    },
  });

/** Look up the active OTP record and enforce expiry + attempt limits. */
async function checkOtp(userId: string, otp: string): Promise<{ ok: true; recordId: string } | { ok: false; message: string }> {
  const record = await prisma.auditLog.findFirst({
    where: { userId, action: 'PASSWORD_RESET_OTP' },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) return { ok: false, message: 'No active OTP found. Please request a new code.' };

  let details: { otpHash?: string; expiresAt?: number; attempts?: number } = {};
  try {
    details = JSON.parse(record.details || '{}');
  } catch {
    details = {};
  }
  if (!details.otpHash || !details.expiresAt || Date.now() > details.expiresAt) {
    return { ok: false, message: 'OTP has expired. Please click Resend Code.' };
  }
  const attempts = details.attempts || 0;
  if (attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
  }
  if (!/^\d{6}$/.test(otp) || !timingSafeEqualHex(details.otpHash, hashOtp(userId, otp))) {
    await prisma.auditLog.update({
      where: { id: record.id },
      data: { details: JSON.stringify({ ...details, attempts: attempts + 1 }) },
    });
    return { ok: false, message: 'Invalid OTP code. Please check your email or click Resend Code.' };
  }
  return { ok: true, recordId: record.id };
}

// Rate Limiting & Failed Login Lockout Tracker (FR-AUTH-008)
interface FailedAttempt {
  count: number;
  lockedUntil: number;
}
const failedLogins = new Map<string, FailedAttempt>();

// Helper to sanitize key
const normalizeKey = (key: string) => key.trim().toLowerCase();

// bcrypt hash of a random string, used to equalise timing for unknown usernames.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

/**
 * Enforce Password Policy (FR-AUTH-008, FR-AUTH-015)
 * - Minimum 8 characters
 * - At least one uppercase letter (A-Z)
 * - At least one lowercase letter (a-z)
 * - At least one number (0-9)
 * - At least one special character (!@#$%^&*...)
 */
const withoutPasswordHash = <T extends { passwordHash?: string }>(u: T): Omit<T, 'passwordHash'> => {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
};

export const validatePasswordPolicy = (password: string): { valid: boolean; message?: string } => {
  if (!password || password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter (A-Z).' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter (a-z).' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number (0-9).' };
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one special character (!@#$%^&*...).' };
  }
  return { valid: true };
};

/**
 * FR-AUTH-001, FR-AUTH-002, FR-AUTH-004, FR-AUTH-008, FR-AUTH-012
 * User Login with Credentials Validation, Rate Limiting & Audit Logging
 */
export const login = async (req: AuthRequest, res: Response) => {
  try {
    const { usernameOrPhone, password } = req.body;

    if (!usernameOrPhone || !password) {
      return res.status(400).json({ success: false, message: 'Username/phone and password are required' });
    }

    const trimmedInput = usernameOrPhone.toString().trim();
    const key = normalizeKey(trimmedInput);
    const now = Date.now();

    // Check rate limit / lockout status (FR-AUTH-008)
    const lockInfo = failedLogins.get(key);
    if (lockInfo && lockInfo.lockedUntil > now) {
      const remainingMinutes = Math.ceil((lockInfo.lockedUntil - now) / 60000);
      return res.status(429).json({
        success: false,
        message: `Account temporarily locked due to repeated failed login attempts. Please try again in ${remainingMinutes} minute(s) or reset your password.`,
      });
    }

    const cleanPhone = trimmedInput.replace(/\D/g, '');
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: trimmedInput, mode: 'insensitive' } },
          { phone: trimmedInput },
          ...(cleanPhone && cleanPhone.length >= 10
            ? [{ phone: cleanPhone }, { phone: cleanPhone.slice(-10) }]
            : []),
          { email: { equals: trimmedInput, mode: 'insensitive' } },
        ],
      },
      include: {
        company: true,
      },
    });

    // Helper to register failed attempt
    const recordFailedAttempt = async () => {
      const current = failedLogins.get(key) || { count: 0, lockedUntil: 0 };
      current.count += 1;
      if (current.count >= 5) {
        current.lockedUntil = now + 15 * 60 * 1000; // 15-minute lockout
      }
      failedLogins.set(key, current);

      // Audit log failed attempt (FR-AUTH-012)
      try {
        await prisma.auditLog.create({
          data: {
            companyId: user?.companyId || null,
            userId: user?.id || null,
            action: 'LOGIN_FAILED',
            entity: 'User',
            entityId: user?.id || null,
            details: JSON.stringify({ attemptedIdentifier: trimmedInput, attemptsCount: current.count }),
            ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
          },
        });
      } catch (e) {}
    };

    if (!user) {
      // Spend comparable time to a real check so response timing does not reveal valid usernames.
      await bcrypt.compare(String(password), DUMMY_PASSWORD_HASH);
      await recordFailedAttempt();
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Only the stored bcrypt hash is accepted (the former hard-coded "universal" passwords were removed).
    const isMatch = await bcrypt.compare(String(password), user.passwordHash);

    if (!isMatch) {
      await recordFailedAttempt();
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Account Status Enforcement (FR-AUTH-007, FR-AUTH-011)
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        message: `Account is currently ${user.status.toLowerCase()}. Please contact your platform administrator.`,
      });
    }

    // P7: member logins work only while the company's member portal is enabled (decision D-02).
    if (user.role === 'MEMBER' && !user.company?.memberPortalEnabled) {
      return res.status(403).json({ success: false, code: 'MEMBER_PORTAL_DISABLED', message: 'Member access is not enabled for this company.' });
    }

    // Company Status Enforcement: Block access if company is deleted
    if (
      user.role !== 'SUPER_ADMIN' &&
      user.company &&
      (user.company.status === 'DELETED' || user.company.status === 'deleted')
    ) {
      return res.status(403).json({
        success: false,
        message: 'This company account has been deleted. Please contact platform administration.',
      });
    }

    // Reset failed login counter on success
    failedLogins.delete(key);

    // Enforce Single Active Window/Session: Invalidate any previous sessions for this user
    await prisma.refreshToken.deleteMany({
      where: { userId: user.id },
    });

    const sessionId = crypto.randomUUID();

    const accessToken = signAccessToken(user, sessionId);

    const refreshToken = jwt.sign({ userId: user.id, sessionId }, env.refreshTokenSecret, {
      algorithm: 'HS256',
      expiresIn: env.refreshTokenExpiresIn as jwt.SignOptions['expiresIn'],
    });
    const refreshExp = (jwt.decode(refreshToken) as jwt.JwtPayload).exp!;

    // Store active session token in DB with sessionId
    await prisma.refreshToken.create({
      data: {
        id: sessionId,
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(refreshExp * 1000),
      },
    });

    // Note: Tokens are returned in JSON response and stored in tab-isolated sessionStorage
    // No browser-wide cookies are set to prevent cross-tab session collisions

    // Record successful login audit log (FR-AUTH-012)
    try {
      await prisma.auditLog.create({
        data: {
          companyId: user.companyId || null,
          userId: user.id,
          action: 'USER_LOGIN',
          entity: 'User',
          entityId: user.id,
          details: JSON.stringify({
            sessionId: sessionId,
            sessionStatus: 'ACTIVE',
            loginTime: new Date().toISOString(),
            ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
          }),
          ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
        },
      });
    } catch (e) {}

    // FR-AUTH-002: Identify role and company
    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.fullName,
          phone: user.phone,
          email: user.email,
          role: user.role,
          company: user.company
            ? {
                id: user.company.id,
                name: user.company.name,
                code: user.company.code,
              }
            : null,
        },
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-005, FR-AUTH-012, FR-AUTH-013
 * Logout & Session Invalidation
 */
export const logout = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const sessionId = req.user?.sessionId;

    // Invalidate ONLY this specific session belonging to this authenticated user
    // Never delete or touch other users' sessions
    if (sessionId && userId) {
      await prisma.refreshToken.deleteMany({
        where: { id: sessionId, userId: userId },
      });
    } else if (userId) {
      await prisma.refreshToken.deleteMany({
        where: { userId: userId },
      });
    }

    if (userId) {
      try {
        await prisma.auditLog.create({
          data: {
            companyId: req.user?.companyId || null,
            userId: userId,
            action: 'USER_LOGOUT',
            entity: 'User',
            entityId: userId,
            details: JSON.stringify({
              sessionId: sessionId || `sess_${userId.slice(0, 8)}`,
              sessionStatus: 'TERMINATED',
              logoutTime: new Date().toISOString(),
            }),
            ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
          },
        });
      } catch (e) {}
    }

    return res.json({
      success: true,
      message: 'Logged out successfully.',
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-009
 * Refresh Expired Access Token via Refresh Token
 */
export const refreshToken = async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Refresh token is required' });
    }

    if (typeof token !== 'string') {
      return res.status(400).json({ success: false, message: 'Refresh token must be a string' });
    }

    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, env.refreshTokenSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    } catch (e) {
      return res.status(403).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    // Verify token exists in database (session tracking)
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!storedToken || storedToken.expiresAt < new Date() || storedToken.userId !== decoded.userId) {
      if (storedToken) {
        await prisma.refreshToken.delete({ where: { token } });
      }
      return res.status(403).json({ success: false, message: 'Session expired or revoked. Please log in again.' });
    }

    if (storedToken.user.status !== 'ACTIVE') {
      await prisma.refreshToken.delete({ where: { token } });
      return res.status(403).json({ success: false, message: 'User account is no longer active.' });
    }

    const newAccessToken = signAccessToken(storedToken.user, storedToken.id);

    // The API authenticates with the Authorization header only; no auth cookie is set.
    return res.json({
      success: true,
      data: { accessToken: newAccessToken },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-002, FR-AUTH-010
 * Current User Identity & Permission Verification
 */
export const me = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        company: true,
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        phone: user.phone,
        email: user.email,
        role: user.role,
        aadhaarNo: user.aadhaarNo,
        panNo: user.panNo,
        address: user.address,
        emergencyContact: user.emergencyContact,
        dateOfBirth: user.dateOfBirth,
        company: user.company
          ? {
              id: user.company.id,
              name: user.company.name,
              code: user.company.code,
            }
          : null,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * Update Profile for Logged-in User (Staff, Manager, Admin)
 * Allows updating personal & KYC details (Aadhaar, PAN, Address, etc.)
 */
export const updateProfile = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { fullName, phone, email, aadhaarNo, panNo, address, emergencyContact, dateOfBirth } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (phone && phone.trim() !== user.phone) {
      const existing = await prisma.user.findFirst({
        where: { phone: phone.trim(), id: { not: userId } },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Phone number is already registered to another account' });
      }
    }

    if (email && email.trim().toLowerCase() !== (user.email || '').toLowerCase()) {
      const existing = await prisma.user.findFirst({
        where: { email: email.trim().toLowerCase(), id: { not: userId } },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Email address is already in use' });
      }
    }

    const updateData: any = {};
    if (fullName !== undefined && fullName.trim()) updateData.fullName = fullName.trim();
    if (phone !== undefined && phone.trim()) updateData.phone = phone.trim();
    if (email !== undefined) updateData.email = email ? email.trim().toLowerCase() : null;
    if (aadhaarNo !== undefined) updateData.aadhaarNo = aadhaarNo ? String(aadhaarNo).trim() : null;
    if (panNo !== undefined) updateData.panNo = panNo ? String(panNo).trim().toUpperCase() : null;
    if (address !== undefined) updateData.address = address ? String(address).trim() : null;
    if (emergencyContact !== undefined) updateData.emergencyContact = emergencyContact ? String(emergencyContact).trim() : null;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth ? String(dateOfBirth).trim() : null;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      include: {
        company: true,
      },
    });

    return res.json({
      success: true,
      message: 'Profile details updated successfully',
      data: {
        id: updatedUser.id,
        username: updatedUser.username,
        fullName: updatedUser.fullName,
        phone: updatedUser.phone,
        email: updatedUser.email,
        role: updatedUser.role,
        aadhaarNo: updatedUser.aadhaarNo,
        panNo: updatedUser.panNo,
        address: updatedUser.address,
        emergencyContact: updatedUser.emergencyContact,
        dateOfBirth: updatedUser.dateOfBirth,
        company: updatedUser.company ? { id: updatedUser.company.id, name: updatedUser.company.name, code: updatedUser.company.code } : null,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-015
 * Change Password with Current Password Verification
 */
export const changePassword = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required' });
    }

    const policyCheck = validatePasswordPolicy(newPassword);
    if (!policyCheck.valid) {
      return res.status(400).json({ success: false, message: policyCheck.message });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(String(currentPassword), user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // FR-AUTH-013: Revoke other sessions on password change
    await prisma.refreshToken.deleteMany({
      where: { userId: user.id },
    });

    // Record audit log
    try {
      await prisma.auditLog.create({
        data: {
          companyId: user.companyId || null,
          userId: user.id,
          action: 'PASSWORD_CHANGE',
          entity: 'User',
          entityId: user.id,
          ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
        },
      });
    } catch (e) {}

    return res.json({
      success: true,
      message: 'Password changed successfully. All other active sessions have been terminated.',
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-006: Forgot Password - generate OTP, store only its HMAC, send by email.
 *
 * The response is identical whether or not the account exists (no user enumeration)
 * and never contains the OTP, even when email delivery fails.
 */
const GENERIC_OTP_MESSAGE =
  'If an account with a registered email matches, a 6-digit verification code has been sent to it.';

export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { emailOrUsername } = req.body || {};

    if (!emailOrUsername || typeof emailOrUsername !== 'string' || emailOrUsername.length > 200) {
      return res.status(400).json({ success: false, message: 'Email or username is required' });
    }

    const trimmed = emailOrUsername.trim();
    const user = await findUserByIdentifier(trimmed);

    if (!user || user.status !== 'ACTIVE' || !user.email || !user.email.includes('@')) {
      return res.json({ success: true, message: GENERIC_OTP_MESSAGE });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + OTP_TTL_MS;

    // Invalidate any previous OTP records for this user, then store the new hashed one.
    await prisma.auditLog.deleteMany({ where: { userId: user.id, action: 'PASSWORD_RESET_OTP' } });
    await prisma.auditLog.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        action: 'PASSWORD_RESET_OTP',
        entity: 'OTP',
        entityId: null,
        details: JSON.stringify({ otpHash: hashOtp(user.id, otp), expiresAt, attempts: 0 }),
        ipAddress: req.ip || 'unknown',
      },
    });

    const emailRes = await sendOtpEmail(user.email, otp, user.fullName || user.username);
    if (!emailRes.success) {
      console.warn(`[ForgotPassword] OTP email could not be delivered for user ${user.id}.`);
    }

    return res.json({ success: true, message: GENERIC_OTP_MESSAGE });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-006: Verify OTP (max 5 attempts per code)
 */
export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { emailOrUsername, otp } = req.body || {};

    if (!emailOrUsername || !otp || typeof emailOrUsername !== 'string') {
      return res.status(400).json({ success: false, message: 'Identifier and OTP are required' });
    }

    const cleanOtp = String(otp).replace(/[^0-9]/g, '');
    const user = await findUserByIdentifier(emailOrUsername.trim());
    if (!user) {
      return res.status(400).json({ success: false, message: 'No active OTP found. Please request a new code.' });
    }

    const result = await checkOtp(user.id, cleanOtp);
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.message });
    }

    return res.json({ success: true, message: 'OTP verified successfully.' });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-006, FR-AUTH-008, FR-AUTH-013: Reset Password with Verified OTP
 */
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { emailOrUsername, otp, newPassword } = req.body || {};

    if (!emailOrUsername || !otp || !newPassword || typeof emailOrUsername !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Identifier, OTP, and new password are required',
      });
    }

    // Validate 8 chars, uppercase, lowercase, number, special char policy
    const policyCheck = validatePasswordPolicy(newPassword);
    if (!policyCheck.valid) {
      return res.status(400).json({ success: false, message: policyCheck.message });
    }

    const cleanOtp = String(otp).replace(/[^0-9]/g, '');
    const user = await findUserByIdentifier(emailOrUsername.trim());
    if (!user) {
      return res.status(400).json({ success: false, message: 'No active OTP requested or it has expired. Please click Resend Code.' });
    }

    const result = await checkOtp(user.id, cleanOtp);
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.message });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      // Consume the OTP and invalidate all existing sessions (FR-AUTH-013)
      prisma.auditLog.deleteMany({ where: { userId: user.id, action: 'PASSWORD_RESET_OTP' } }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
      prisma.auditLog.create({
        data: {
          companyId: user.companyId || null,
          userId: user.id,
          action: 'PASSWORD_RESET',
          entity: 'User',
          entityId: user.id,
          ipAddress: req.ip || 'unknown',
        },
      }),
    ]);

    return res.json({
      success: true,
      message: 'Password reset successful! Your password has been updated in the database. Please log in.',
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-007, FR-AUTH-011: Admin - List Users
 */
export const listUsers = async (req: AuthRequest, res: Response) => {
  try {
    const callerIsSuperAdmin = isSuperAdmin(req);
    const { role, companyId, search } = req.query;
    const whereClause: any = {};

    if (!callerIsSuperAdmin) {
      // Company users only ever see their own company's accounts (never super admins).
      whereClause.companyId = req.user!.companyId;
      whereClause.role = { not: 'SUPER_ADMIN' };
    } else {
      if (companyId && typeof companyId === 'string' && companyId !== 'ALL') {
        whereClause.companyId = companyId;
      }
    }

    if (role && typeof role === 'string' && role !== 'ALL') {
      whereClause.role = callerIsSuperAdmin || role !== 'SUPER_ADMIN' ? role : '__none__';
    }

    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim().slice(0, 100);
      whereClause.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        username: true,
        fullName: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        companyId: true,
        aadhaarNo: true,
        panNo: true,
        address: true,
        emergencyContact: true,
        dateOfBirth: true,
        createdAt: true,
        company: { select: { id: true, name: true, code: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Collection staff may look up colleagues but not their identity documents.
    const data =
      req.user?.role === 'COLLECTION_STAFF'
        ? users.map(({ aadhaarNo, panNo, address, emergencyContact, dateOfBirth, ...rest }) => rest)
        : users;

    return res.json({ success: true, data });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-007, FR-AUTH-008, FR-AUTH-014: Admin - Create User Account
 */
export const createUser = async (req: AuthRequest, res: Response) => {
  try {
    const {
      username,
      fullName,
      phone,
      email,
      password,
      role,
      companyId,
      aadhaarNo,
      panNo,
      address,
      emergencyContact,
      dateOfBirth,
    } = req.body;

    if (!username || !fullName || !phone || !password || !role) {
      return res.status(400).json({ success: false, message: 'Missing required user fields' });
    }
    if (![username, fullName, phone, password, role].every((v) => typeof v === 'string')) {
      return res.status(400).json({ success: false, message: 'Invalid user fields' });
    }
    if (!(ROLES as readonly string[]).includes(role)) {
      return res.status(400).json({ success: false, message: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
    }

    // FR-AUTH-014: Prevent unauthorized role escalation
    const creatorRole = req.user?.role;
    if (creatorRole !== 'SUPER_ADMIN') {
      if (role === 'SUPER_ADMIN') {
        return res.status(403).json({ success: false, message: 'Only Super Administrators can create Super Admin accounts.' });
      }
    }

    // Tenant: company users can only create accounts inside their own company;
    // super admins must name an existing company for company roles.
    let targetCompanyId: string | null;
    if (creatorRole === 'SUPER_ADMIN') {
      targetCompanyId = role === 'SUPER_ADMIN' ? null : typeof companyId === 'string' && companyId ? companyId : null;
      if (role !== 'SUPER_ADMIN') {
        if (!targetCompanyId) {
          return res.status(400).json({ success: false, message: 'companyId is required for company users' });
        }
        const company = await prisma.company.findUnique({ where: { id: targetCompanyId }, select: { id: true } });
        if (!company) {
          return res.status(404).json({ success: false, message: 'Company not found' });
        }
      }
    } else {
      targetCompanyId = req.user!.companyId || null;
    }

    const policy = validatePasswordPolicy(password);
    if (!policy.valid) {
      return res.status(400).json({ success: false, message: policy.message });
    }

    const trimmedEmail = email ? String(email).trim().toLowerCase() : null;

    // Check unique constraints
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username: username.trim() },
          { phone: phone.trim() },
          ...(trimmedEmail ? [{ email: trimmedEmail }] : []),
        ],
      },
    });

    if (existing) {
      return res.status(409).json({ success: false, message: 'Username, phone number, or email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const newUser = await prisma.user.create({
      data: {
        username: username.trim(),
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: trimmedEmail,
        passwordHash,
        role,
        companyId: targetCompanyId,
        status: 'ACTIVE',
        aadhaarNo: aadhaarNo ? String(aadhaarNo).trim() : null,
        panNo: panNo ? String(panNo).trim().toUpperCase() : null,
        address: address ? String(address).trim() : null,
        emergencyContact: emergencyContact ? String(emergencyContact).trim() : null,
        dateOfBirth: dateOfBirth ? String(dateOfBirth).trim() : null,
      },
      include: {
        company: true,
      },
    });

    // Automatically email credentials to desired Gmail / Email
    let credentialsEmailSent = false;
    let emailErrorMessage: string | null = null;
    const recipientEmail = (trimmedEmail || '').trim();
    if (recipientEmail && recipientEmail.includes('@')) {
      try {
        let companyName = newUser.company?.name || undefined;
        let companyCode = newUser.company?.code || undefined;
        if (!companyName && newUser.companyId) {
          const comp = await prisma.company.findUnique({ where: { id: newUser.companyId } });
          if (comp) {
            companyName = comp.name;
            companyCode = comp.code;
          }
        }

        const roleTitle = newUser.role === 'MANAGER'
          ? 'Company Administrator (Manager)'
          : newUser.role === 'SUPER_ADMIN'
          ? 'Super Administrator'
          : newUser.role.replace('_', ' ');

        const emailResult = await sendAdminCredentialsEmail({
          to: recipientEmail,
          fullName: newUser.fullName,
          username: newUser.username,
          password: password,
          role: roleTitle,
          companyName: companyName || 'ChitKart Platform',
          companyCode: companyCode,
          loginUrl: env.portalUrl,
        });
        credentialsEmailSent = !!emailResult.success;
        if (!emailResult.success) {
          emailErrorMessage = emailResult.error || 'Failed to dispatch email';
        }
      } catch (emailErr: any) {
        console.error('[createUser] Failed to send credentials email:', emailErr.message);
        emailErrorMessage = emailErr.message;
      }
    }

    // Audit Log (FR-AUTH-012)
    try {
      await prisma.auditLog.create({
        data: {
          companyId: newUser.companyId || null,
          userId: req.user?.id || null,
          action: 'USER_CREATED',
          entity: 'User',
          entityId: newUser.id,
          details: JSON.stringify({
            createdUser: newUser.username,
            role: newUser.role,
            email: recipientEmail || null,
            credentialsEmailSent,
            emailErrorMessage,
          }),
          ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
        },
      });
    } catch (e) {}

    return res.status(201).json({
      success: true,
      message: credentialsEmailSent
        ? `User created successfully! Login credentials have been automatically dispatched to ${recipientEmail}.`
        : recipientEmail
        ? `User created successfully! Notice: Credentials email dispatch pending: ${emailErrorMessage || 'Check SMTP configuration'}`
        : 'User created successfully',
      data: {
        id: newUser.id,
        username: newUser.username,
        fullName: newUser.fullName,
        phone: newUser.phone,
        email: newUser.email,
        role: newUser.role,
        status: newUser.status,
        aadhaarNo: newUser.aadhaarNo,
        panNo: newUser.panNo,
        address: newUser.address,
        emergencyContact: newUser.emergencyContact,
        dateOfBirth: newUser.dateOfBirth,
        credentialsEmailSent,
      },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-007, FR-AUTH-012, FR-AUTH-013, FR-AUTH-014: Activate / Suspend / Deactivate User Account
 */
export const updateUserStatus = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['ACTIVE', 'SUSPENDED', 'DEACTIVATED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status. Must be ACTIVE, SUSPENDED, or DEACTIVATED.' });
    }

    // FR-AUTH-014: Prevent modifying own account status or self-deactivation
    if (req.user?.id === id) {
      return res.status(400).json({ success: false, message: 'You cannot alter your own account status.' });
    }

    // Tenant isolation: managers can only manage users of their own company.
    const targetUser = await loadUserForTenant(req, id);

    // Role Escalation check
    if (targetUser.role === 'SUPER_ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Cannot modify Super Admin accounts.' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { status },
    });

    // FR-AUTH-013: Session Revocation when account is suspended or deactivated
    if (status !== 'ACTIVE') {
      await prisma.refreshToken.deleteMany({
        where: { userId: id },
      });
    }

    // Audit Log (FR-AUTH-012)
    try {
      await prisma.auditLog.create({
        data: {
          companyId: targetUser.companyId || null,
          userId: req.user?.id || null,
          action: 'USER_STATUS_CHANGE',
          entity: 'User',
          entityId: id,
          details: JSON.stringify({ oldStatus: targetUser.status, newStatus: status }),
          ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
        },
      });
    } catch (e) {}

    return res.json({
      success: true,
      message: `User account status updated to ${status}. ${status !== 'ACTIVE' ? 'All active sessions revoked.' : ''}`,
      data: { id: updated.id, status: updated.status },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * FR-AUTH-013: Terminate User Sessions
 */
export const revokeUserSessions = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Tenant isolation: managers can only manage users of their own company.
    const targetUser = await loadUserForTenant(req, id);

    const deleted = await prisma.refreshToken.deleteMany({
      where: { userId: id },
    });

    // Audit Log
    try {
      await prisma.auditLog.create({
        data: {
          companyId: targetUser.companyId || null,
          userId: req.user?.id || null,
          action: 'SESSION_REVOCATION',
          entity: 'User',
          entityId: id,
          details: JSON.stringify({ sessionsRevoked: deleted.count }),
          ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
        },
      });
    } catch (e) {}

    return res.json({
      success: true,
      message: `Terminated ${deleted.count} active session(s) for user ${targetUser.username}.`,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * Super Admin & Admin: Update Any User Credential
 * Allows updating fullName, username, phone, email, role, status, company, KYC fields, and direct password reset
 */
export const updateUser = async (req: AuthRequest, res: Response) => {
  try {
    const {
      id,
    } = req.params;
    const {
      fullName,
      username,
      phone,
      email,
      role,
      companyId,
      status,
      password,
      aadhaarNo,
      panNo,
      address,
      emergencyContact,
      dateOfBirth,
    } = req.body;

    // Tenant isolation: managers can only manage users of their own company.
    const targetUser = await loadUserForTenant(req, id);

    // Role escalation check
    if (req.user?.role !== 'SUPER_ADMIN') {
      if (targetUser.role === 'SUPER_ADMIN' || role === 'SUPER_ADMIN') {
        return res.status(403).json({ success: false, message: 'Only Super Administrators can manage Super Admin accounts.' });
      }
    }

    // Uniqueness checks if username, phone, or email are changed
    if (username && username.trim() !== targetUser.username) {
      const existing = await prisma.user.findFirst({
        where: { username: username.trim(), id: { not: id } },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Username is already taken by another account.' });
      }
    }

    if (phone && phone.trim() !== targetUser.phone) {
      const existing = await prisma.user.findFirst({
        where: { phone: phone.trim(), id: { not: id } },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Phone number is already registered to another account.' });
      }
    }

    if (email && email.trim() !== (targetUser.email || '')) {
      const existing = await prisma.user.findFirst({
        where: { email: email.trim(), id: { not: id } },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Email address is already in use.' });
      }
    }

    const updateData: any = {};
    if (fullName) updateData.fullName = fullName.trim();
    if (username) updateData.username = username.trim();
    if (phone) updateData.phone = phone.trim();
    if (email !== undefined) updateData.email = email ? email.trim() : null;
    if (role) {
      if (!(ROLES as readonly string[]).includes(role)) {
        return res.status(400).json({ success: false, message: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
      }
      updateData.role = role;
    }
    if (status) {
      if (!['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'INACTIVE'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
      }
      if (req.user?.id === id && status !== targetUser.status) {
        return res.status(400).json({ success: false, message: 'You cannot alter your own account status.' });
      }
      updateData.status = status;
    }
    // Only a super admin may move a user between companies.
    if (companyId !== undefined && isSuperAdmin(req)) {
      if (companyId) {
        const company = await prisma.company.findUnique({ where: { id: String(companyId) }, select: { id: true } });
        if (!company) return res.status(404).json({ success: false, message: 'Company not found' });
      }
      updateData.companyId = companyId || null;
    }
    if (aadhaarNo !== undefined) updateData.aadhaarNo = aadhaarNo ? String(aadhaarNo).trim() : null;
    if (panNo !== undefined) updateData.panNo = panNo ? String(panNo).trim().toUpperCase() : null;
    if (address !== undefined) updateData.address = address ? String(address).trim() : null;
    if (emergencyContact !== undefined) updateData.emergencyContact = emergencyContact ? String(emergencyContact).trim() : null;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth ? String(dateOfBirth).trim() : null;

    // Direct password reset by Super Admin / Manager (own company only)
    if (password && password.trim()) {
      const policy = validatePasswordPolicy(password);
      if (!policy.valid) {
        return res.status(400).json({ success: false, message: policy.message });
      }
      updateData.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      // Revoke user's existing sessions
      await prisma.refreshToken.deleteMany({ where: { userId: id } });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
      include: {
        company: { select: { id: true, name: true, code: true } },
      },
    });

    // Audit Log
    try {
      await prisma.auditLog.create({
        data: {
          companyId: updatedUser.companyId || null,
          userId: req.user?.id || null,
          action: 'USER_UPDATED',
          entity: 'User',
          entityId: id,
          details: JSON.stringify({
            updatedBy: req.user?.fullName || req.user?.id,
            fieldsUpdated: Object.keys(updateData).filter((k) => k !== 'passwordHash'),
            passwordReset: !!password,
          }),
          ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
        },
      });
    } catch (e) {}

    // If password was reset, automatically email new credentials to user's email
    let credentialsEmailSent = false;
    if (password && password.trim() && updatedUser.email && updatedUser.email.includes('@')) {
      try {
        const roleTitle = updatedUser.role === 'MANAGER'
          ? 'Company Administrator (Manager)'
          : updatedUser.role === 'SUPER_ADMIN'
          ? 'Super Administrator'
          : updatedUser.role.replace('_', ' ');

        await sendAdminCredentialsEmail({
          to: updatedUser.email.trim(),
          fullName: updatedUser.fullName,
          username: updatedUser.username,
          password: password.trim(),
          role: roleTitle,
          companyName: updatedUser.company?.name || 'ChitKart Platform',
          companyCode: updatedUser.company?.code || undefined,
          loginUrl: env.portalUrl,
        });
        credentialsEmailSent = true;
      } catch (e: any) {
        console.error('[updateUser] Failed to send updated credentials email:', e.message);
      }
    }

    return res.json({
      success: true,
      message: `User credentials for @${updatedUser.username} updated successfully.${password ? ' Password reset complete.' : ''}${credentialsEmailSent ? ` New credentials dispatched to ${updatedUser.email}.` : ''}`,
      data: { ...withoutPasswordHash(updatedUser), credentialsEmailSent },
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};

/**
 * Super Admin: Delete User Credential
 * Permanently deletes unlinked user accounts or safely deactivates users linked to financial ledgers
 */
export const deleteUser = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (req.user?.id === id) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }

    // Tenant isolation: managers can only manage users of their own company.
    const targetUser = await loadUserForTenant(req, id);

    if (targetUser.role === 'SUPER_ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Only Super Administrators can delete Super Admin accounts.' });
    }

    if (targetUser.role === 'SUPER_ADMIN') {
      const activeSuperAdmins = await prisma.user.count({
        where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      });
      if (activeSuperAdmins <= 1) {
        return res.status(400).json({ success: false, message: 'Cannot delete the platform\'s last active Super Administrator.' });
      }
    }

    // Revoke sessions first
    await prisma.refreshToken.deleteMany({ where: { userId: id } });

    let permanentlyDeleted = false;
    try {
      await prisma.user.delete({ where: { id } });
      permanentlyDeleted = true;
    } catch (e: any) {
      // If foreign keys prevent hard delete (recorded transactions, payouts, etc.), safely deactivate
      await prisma.user.update({
        where: { id },
        data: { status: 'DEACTIVATED' },
      });
    }

    // Audit log
    try {
      await prisma.auditLog.create({
        data: {
          companyId: targetUser.companyId || null,
          userId: req.user?.id || null,
          action: 'USER_DELETED',
          entity: 'User',
          entityId: id,
          details: JSON.stringify({
            username: targetUser.username,
            role: targetUser.role,
            type: permanentlyDeleted ? 'PERMANENT_DELETE' : 'DEACTIVATED_DUE_TO_FINANCIAL_RECORDS',
          }),
          ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
        },
      });
    } catch (e) {}

    return res.json({
      success: true,
      message: permanentlyDeleted
        ? `User @${targetUser.username} permanently deleted from platform.`
        : `User @${targetUser.username} has linked financial records. Account was safely deactivated and all active sessions revoked.`,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
};
