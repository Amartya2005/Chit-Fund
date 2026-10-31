import { beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { api, bearer, createCompany, createUser, login, prisma, resetDb, PASSWORD } from '../helpers.js';

let company: { id: string };
let manager: Awaited<ReturnType<typeof createUser>>;
let staff: Awaited<ReturnType<typeof createUser>>;
let superAdmin: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  await resetDb();
  company = await createCompany('AUTH');
  manager = await createUser('MANAGER', company.id, 'auth_m');
  staff = await createUser('COLLECTION_STAFF', company.id, 'auth_s');
  superAdmin = await createUser('SUPER_ADMIN', null, 'auth_sa');
});

describe('login', () => {
  it('accepts the real password and returns tokens + user (no password hash)', async () => {
    const res = await api().post('/api/v1/auth/login').send({ usernameOrPhone: manager.username, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.role).toBe('MANAGER');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it.each(['admin123', 'Admin@123', 'Akshyat@2026!', 'NewPassword@2026!', 'Manager@123', 'Staff@123', 'Chitkart@2026!', 'Password@123'])(
    'rejects former universal backdoor password %s',
    async (pw) => {
      // fresh account per attempt so the 5-attempt lockout does not interfere
      const victim = await createUser('MANAGER', company.id, `bd_${crypto.randomUUID().slice(0, 6)}`);
      const res = await api().post('/api/v1/auth/login').send({ usernameOrPhone: victim.username, password: pw });
      expect(res.status).toBe(401);
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
      expect(stored.passwordHash).toBe(victim.passwordHash); // no "auto-heal" overwrite
    }
  );

  it('rejects wrong passwords and unknown users with the same message', async () => {
    const other = await createUser('COLLECTION_STAFF', company.id, 'wrongpw');
    const a = await api().post('/api/v1/auth/login').send({ usernameOrPhone: other.username, password: 'Wrong!Pass1' });
    const b = await api().post('/api/v1/auth/login').send({ usernameOrPhone: 'nobody_here', password: 'Wrong!Pass1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('locks an account after 5 failed attempts', async () => {
    const u = await createUser('COLLECTION_STAFF', company.id, 'lockme');
    for (let i = 0; i < 5; i++) {
      await api().post('/api/v1/auth/login').send({ usernameOrPhone: u.username, password: 'Bad!Pass1' });
    }
    const res = await api().post('/api/v1/auth/login').send({ usernameOrPhone: u.username, password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it('refuses inactive accounts', async () => {
    const u = await createUser('COLLECTION_STAFF', company.id, 'inactive');
    await prisma.user.update({ where: { id: u.id }, data: { status: 'SUSPENDED' } });
    const res = await api().post('/api/v1/auth/login').send({ usernameOrPhone: u.username, password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('token validation', () => {
  it('requires a bearer token', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects tokens signed with the old hard-coded fallback secret', async () => {
    const forged = jwt.sign({ userId: superAdmin.id, sessionId: crypto.randomUUID(), role: 'SUPER_ADMIN' }, 'chitfund_super_secure_jwt_secret_key_2026!@#');
    const res = await api().get('/api/v1/super-admin/dashboard').set(bearer(forged));
    expect(res.status).toBe(403);
  });

  it('rejects expired tokens', async () => {
    const token = await login(manager.username);
    const { sessionId } = jwt.decode(token) as any;
    const expired = jwt.sign({ userId: manager.id, sessionId, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!);
    expect((await api().get('/api/v1/auth/me').set(bearer(expired))).status).toBe(403);
  });

  it('rejects alg=none tokens', async () => {
    const token = await login(manager.username);
    const { sessionId } = jwt.decode(token) as any;
    const none = jwt.sign({ userId: manager.id, sessionId, role: 'SUPER_ADMIN' }, '', { algorithm: 'none' as any });
    expect((await api().get('/api/v1/auth/me').set(bearer(none))).status).toBe(403);
  });

  it('takes role and company from the database, not from the token payload', async () => {
    const token = await login(staff.username);
    const { sessionId } = jwt.decode(token) as any;
    // Correctly signed token that claims SUPER_ADMIN for a staff user
    const escalated = jwt.sign({ userId: staff.id, sessionId, role: 'SUPER_ADMIN', companyId: null }, process.env.JWT_SECRET!);
    const res = await api().get('/api/v1/super-admin/companies').set(bearer(escalated));
    expect(res.status).toBe(403);
    const me = await api().get('/api/v1/auth/me').set(bearer(escalated));
    expect(me.body.data.role).toBe('COLLECTION_STAFF');
  });

  it('terminates the old session when the same user logs in again', async () => {
    const first = await login(manager.username);
    const second = await login(manager.username);
    const old = await api().get('/api/v1/auth/me').set(bearer(first));
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('SESSION_TERMINATED');
    expect((await api().get('/api/v1/auth/me').set(bearer(second))).status).toBe(200);
  });

  it('logout revokes the session', async () => {
    const token = await login(manager.username);
    expect((await api().post('/api/v1/auth/logout').set(bearer(token))).status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });

  it('refresh token issues a new access token for the same session only', async () => {
    const res = await api().post('/api/v1/auth/login').send({ usernameOrPhone: staff.username, password: PASSWORD });
    const refreshed = await api().post('/api/v1/auth/refresh-token').send({ refreshToken: res.body.data.refreshToken });
    expect(refreshed.status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set(bearer(refreshed.body.data.accessToken))).status).toBe(200);
    const bogus = await api().post('/api/v1/auth/refresh-token').send({ refreshToken: 'not-a-token' });
    expect(bogus.status).toBe(403);
  });
});

describe('role based access', () => {
  it('blocks staff and managers from super admin endpoints', async () => {
    const st = await login(staff.username);
    const mt = await login(manager.username);
    for (const t of [st, mt]) {
      expect((await api().get('/api/v1/super-admin/companies').set(bearer(t))).status).toBe(403);
      expect((await api().get('/api/v1/super-admin/export').set(bearer(t))).status).toBe(403);
      expect((await api().get('/api/v1/super-admin/audit-logs').set(bearer(t))).status).toBe(403);
    }
  });

  it('blocks staff from manager-only financial endpoints', async () => {
    const st = await login(staff.username);
    expect((await api().get('/api/v1/accounting/accounts').set(bearer(st))).status).toBe(403);
    expect((await api().post('/api/v1/chit-groups').set(bearer(st)).send({ name: 'x' })).status).toBe(403);
    expect((await api().post('/api/v1/auctions/confirm').set(bearer(st)).send({})).status).toBe(403);
    expect((await api().patch('/api/v1/payouts/x/status').set(bearer(st)).send({ status: 'DISBURSED' })).status).toBe(403);
  });

  it('managers cannot create super admins', async () => {
    const mt = await login(manager.username);
    const res = await api().post('/api/v1/auth/users').set(bearer(mt)).send({
      username: 'evil_sa', fullName: 'Evil', phone: '9111111111', password: PASSWORD, role: 'SUPER_ADMIN',
    });
    expect(res.status).toBe(403);
  });

  it('updateUser never returns the password hash', async () => {
    const mt = await login(manager.username);
    const u = await createUser('COLLECTION_STAFF', company.id, 'nohash');
    const res = await api().put(`/api/v1/auth/users/${u.id}`).set(bearer(mt)).send({ fullName: 'Renamed Staff' });
    expect(res.status).toBe(200);
    expect(res.body.data.passwordHash).toBeUndefined();
  });
});

describe('password reset (OTP)', () => {
  it('does not reveal whether an account exists and never returns the OTP', async () => {
    const known = await api().post('/api/v1/auth/forgot-password').send({ emailOrUsername: manager.username });
    const unknown = await api().post('/api/v1/auth/forgot-password').send({ emailOrUsername: 'no_such_user' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body.message).toBe(unknown.body.message);
    expect(known.body.otp).toBeUndefined();
    expect(JSON.stringify(known.body)).not.toMatch(/\b\d{6}\b/);
  });

  it('stores only an HMAC of the OTP (no plaintext code in the audit log)', async () => {
    await api().post('/api/v1/auth/forgot-password').send({ emailOrUsername: manager.username });
    const rec = await prisma.auditLog.findFirst({ where: { userId: manager.id, action: 'PASSWORD_RESET_OTP' } });
    expect(rec).toBeTruthy();
    expect(rec!.entityId).toBeNull();
    const details = JSON.parse(rec!.details!);
    expect(details.otp).toBeUndefined();
    expect(details.otpHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('locks the code after 5 wrong guesses, then a correct code is refused', async () => {
    const u = await createUser('COLLECTION_STAFF', company.id, 'otp1');
    // Plant a known OTP the same way the server does (HMAC with the server secret).
    const otp = '123456';
    const otpHash = crypto.createHmac('sha256', process.env.REFRESH_TOKEN_SECRET!).update(`${u.id}:${otp}`).digest('hex');
    await prisma.auditLog.create({
      data: { userId: u.id, action: 'PASSWORD_RESET_OTP', entity: 'OTP', details: JSON.stringify({ otpHash, expiresAt: Date.now() + 600000, attempts: 0 }) },
    });
    for (let i = 0; i < 5; i++) {
      const r = await api().post('/api/v1/auth/verify-otp').send({ emailOrUsername: u.username, otp: String(100000 + i) });
      expect(r.status).toBe(400);
    }
    const res = await api().post('/api/v1/auth/verify-otp').send({ emailOrUsername: u.username, otp });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Too many/);
  });

  it('resets the password with a valid code, consumes the code and revokes sessions', async () => {
    const u = await createUser('COLLECTION_STAFF', company.id, 'otp2');
    const oldToken = await login(u.username);
    const otp = '654321';
    const otpHash = crypto.createHmac('sha256', process.env.REFRESH_TOKEN_SECRET!).update(`${u.id}:${otp}`).digest('hex');
    await prisma.auditLog.create({
      data: { userId: u.id, action: 'PASSWORD_RESET_OTP', entity: 'OTP', details: JSON.stringify({ otpHash, expiresAt: Date.now() + 600000, attempts: 0 }) },
    });
    const res = await api().post('/api/v1/auth/reset-password').send({ emailOrUsername: u.username, otp, newPassword: 'N3w!Password' });
    expect(res.status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set(bearer(oldToken))).status).toBe(401);
    await login(u.username, 'N3w!Password');
    const reuse = await api().post('/api/v1/auth/reset-password').send({ emailOrUsername: u.username, otp, newPassword: 'An0ther!Pass' });
    expect(reuse.status).toBe(400);
  });

  it('rejects expired codes', async () => {
    const u = await createUser('COLLECTION_STAFF', company.id, 'otp3');
    const otp = '111222';
    const otpHash = crypto.createHmac('sha256', process.env.REFRESH_TOKEN_SECRET!).update(`${u.id}:${otp}`).digest('hex');
    await prisma.auditLog.create({
      data: { userId: u.id, action: 'PASSWORD_RESET_OTP', entity: 'OTP', details: JSON.stringify({ otpHash, expiresAt: Date.now() - 1, attempts: 0 }) },
    });
    const res = await api().post('/api/v1/auth/verify-otp').send({ emailOrUsername: u.username, otp });
    expect(res.status).toBe(400);
  });
});

describe('error responses', () => {
  it('do not leak database internals', async () => {
    const mt = await login(manager.username);
    const res = await api().get('/api/v1/subscribers/%00bad').set(bearer(mt));
    expect([400, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|invalid input syntax|SELECT|constraint/i);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"usernameOrPhone": ');
    expect(res.status).toBe(400);
  });
});
