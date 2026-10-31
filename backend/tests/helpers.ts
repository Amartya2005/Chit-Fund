import request from 'supertest';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';

export { app, prisma };
export const api = () => request(app);
export const PASSWORD = 'Str0ng!Pass';

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

const hash = bcrypt.hashSync(PASSWORD, 4);

export async function createCompany(code: string) {
  return prisma.company.create({ data: { code, name: `Company ${code}`, receiptPrefix: 'REC' } });
}

export async function createUser(role: 'SUPER_ADMIN' | 'MANAGER' | 'COLLECTION_STAFF', companyId: string | null, tag = crypto.randomUUID().slice(0, 8)) {
  return prisma.user.create({
    data: {
      role,
      companyId,
      username: `${role.toLowerCase()}_${tag}`,
      fullName: `${role} ${tag}`,
      phone: `9${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`,
      email: `${role.toLowerCase()}_${tag}@example.test`,
      passwordHash: hash,
      status: 'ACTIVE',
    },
  });
}

export async function login(username: string, password = PASSWORD) {
  const res = await api().post('/api/v1/auth/login').send({ usernameOrPhone: username, password });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A tenant with a manager, a staff member, a chit group (staff assigned) and one enrolled subscriber. */
export async function createTenant(code: string) {
  const company = await createCompany(code);
  const manager = await createUser('MANAGER', company.id, `${code}_m`);
  const staff = await createUser('COLLECTION_STAFF', company.id, `${code}_s`);
  const managerToken = await login(manager.username);
  const staffToken = await login(staff.username);

  const groupRes = await api()
    .post('/api/v1/chit-groups')
    .set(bearer(managerToken))
    .send({ name: `Group ${code}`, chitValue: 100000, maxMembers: 10, totalMonths: 10, startDate: '2026-01-05', assignedStaffId: staff.id });
  if (groupRes.status !== 201) throw new Error(`group create failed: ${JSON.stringify(groupRes.body)}`);
  const group = groupRes.body.data;

  const subRes = await api()
    .post('/api/v1/subscribers')
    .set(bearer(managerToken))
    .send({ fullName: `Member ${code}`, phone: '9000000001', groupId: group.id });
  if (subRes.status !== 201) throw new Error(`subscriber create failed: ${JSON.stringify(subRes.body)}`);
  const subscriber = subRes.body.data;

  return { company, manager, staff, managerToken, staffToken, group, subscriber };
}

export async function recordCash(token: string, subscriberId: string, groupId: string, amount: number | string, installmentNo = 1, extra: Record<string, unknown> = {}) {
  return api()
    .post('/api/v1/collections/pay')
    .set(bearer(token))
    .send({ subscriberId, groupId, installmentNo, amount, paymentMode: 'CASH', notes: 'cash collected at door', ...extra });
}
