import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createTenant, createUser, login, PASSWORD, prisma, recordCash, resetDb } from '../helpers.js';
import { E, addMember, configureCompany, convertGroup, createGroup, enableEngine } from '../engine-helpers.js';
import { todayInIndia } from '../../src/modules/subscribers/arrears.js';
import { addDays } from '../../src/finance/schedule/recurrence.js';

/** P7: member logins, member-only API scope, data isolation between members and companies. */
const today = todayInIndia();
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let saToken: string;
let g: any;
const subs: any[] = [];
let mem1: string;
let mem2: string;

const createLogin = (token: string, subscriberId: string, username: string, extra: Record<string, unknown> = {}) =>
  api().post(`${E}/members/${subscriberId}/login`).set(bearer(token)).send({ username, password: PASSWORD, ...extra });

beforeAll(async () => {
  await resetDb();
  A = await createTenant('MA');
  B = await createTenant('MB');
  saToken = await login((await createUser('SUPER_ADMIN', null, 'p7sa')).username);
  await configureCompany(A.managerToken, saToken, A.company.id);
  await enableEngine(saToken, A.company.id);
  g = await createGroup(A.managerToken, { name: 'Member group', chitValue: 30000, maxMembers: 3, totalMonths: 3, startDate: addDays(today, 2) });
  for (const [i, n] of ['Asha', 'Bala', 'Chitra'].entries()) subs.push(await addMember(A.managerToken, g.id, n, `93000000${i}0`));
  await convertGroup(A.managerToken, g.id);
  await recordCash(A.managerToken, subs[0].id, g.id, 10000, 1);
  await recordCash(A.managerToken, subs[1].id, g.id, 4000, 1);
});

describe('P7 — creating member logins', () => {
  it('requires the member portal to be enabled by the super admin (D-02)', async () => {
    expect((await createLogin(A.managerToken, subs[0].id, 'asha.member')).body.code).toBe('MEMBER_PORTAL_DISABLED');
    expect((await api().patch(`${E}/companies/${A.company.id}/member-portal`).set(bearer(A.managerToken)).send({ enabled: true })).status).toBe(403);
    expect((await api().patch(`${E}/companies/${A.company.id}/member-portal`).set(bearer(saToken)).send({ enabled: true })).status).toBe(200);
  });
  it('one login per member; duplicates, weak passwords, staff and other tenants refused', async () => {
    expect((await createLogin(A.managerToken, subs[0].id, 'asha.member', { password: 'weak' })).status).toBe(400);
    expect((await createLogin(A.managerToken, subs[0].id, 'asha.member')).status).toBe(201);
    expect((await createLogin(A.managerToken, subs[0].id, 'asha.again')).body.code).toBe('LOGIN_EXISTS');
    expect((await createLogin(A.managerToken, subs[1].id, 'asha.member', { phone: '9333333333' })).body.code).toBe('DUPLICATE');
    expect((await createLogin(A.staffToken, subs[1].id, 'bala.member')).status).toBe(403);
    expect((await createLogin(B.managerToken, subs[1].id, 'bala.member')).status).toBe(404);
    expect((await createLogin(A.managerToken, subs[1].id, 'bala.member')).status).toBe(201);
    // the generic user API can never create or assign the member role
    expect((await api().post('/api/v1/auth/users').set(bearer(A.managerToken)).send({ role: 'MEMBER', username: 'x1', fullName: 'X', phone: '9444444444', password: PASSWORD })).status).toBe(400);
    mem1 = await login('asha.member');
    mem2 = await login('bala.member');
  });
});

describe('P7 — member API', () => {
  it('summary, dues and receipts show only the member’s own data', async () => {
    const s1 = await api().get('/api/v1/me/member/summary').set(bearer(mem1));
    expect(s1.status).toBe(200);
    expect(s1.body.data.member.fullName).toBe('Asha');
    expect(s1.body.data.tickets).toHaveLength(1);
    expect(s1.body.data.tickets[0]).toMatchObject({ engine: true, prized: false, group: { name: 'Member group' } });
    const d1 = await api().get(`/api/v1/me/member/dues?asOf=${addDays(today, 2)}`).set(bearer(mem1));
    expect(d1.body.data.tickets[0].dues[0]).toMatchObject({ periodNo: 1, paidAmount: '10000.00', status: 'PAID' });
    const d2 = await api().get(`/api/v1/me/member/dues?asOf=${addDays(today, 2)}`).set(bearer(mem2));
    expect(d2.body.data.tickets[0].dues[0]).toMatchObject({ periodNo: 1, paidAmount: '4000.00', status: 'PARTIAL', outstanding: '6000.00' });
    const p1 = await api().get('/api/v1/me/member/payments').set(bearer(mem1));
    expect(p1.body.data.map((p: any) => p.amount)).toEqual([10000]);
    const p2 = await api().get('/api/v1/me/member/payments').set(bearer(mem2));
    expect(p2.body.data.map((p: any) => p.amount)).toEqual([4000]);
  });

  it('auction results and own eligibility are visible; dividends credited to the member appear', async () => {
    const sess = await api().post(`${E}/groups/${g.id}/sessions`).set(bearer(A.managerToken)).send({ date: today, opensAtLocal: '08:00', closesAtLocal: '09:00' });
    for (const a of ['open', 'close']) await api().post(`${E}/sessions/${sess.body.data.id}/${a}`).set(bearer(A.managerToken)).send({});
    const winner = await prisma.chitGroupMember.findFirstOrThrow({ where: { groupId: g.id, subscriberId: subs[2].id } });
    const r = await api().post(`${E}/sessions/${sess.body.data.id}/result`).set(bearer(A.managerToken)).send({ winnerMemberId: winner.id, discount: '3000' });
    expect(r.status).toBe(201);
    const a1 = await api().get('/api/v1/me/member/auctions').set(bearer(mem1));
    expect(a1.body.data[0]).toMatchObject({ status: 'SETTLED', myTicketNumber: 1, myEligibility: { eligible: true }, result: { winningTicketNumber: 3, iWon: false, discount: '3000.00', dividendPerTicket: '500.00', creditedToPeriod: 1 } }); // next instalment after today's auction
    const dv = await api().get('/api/v1/me/member/dividends').set(bearer(mem1));
    expect(dv.body.data.map((x: any) => [x.amount, x.targetPeriodNo])).toEqual([['500.00', 1]]);
  });

  it('members cannot reach any staff or manager endpoint', async () => {
    const paths = [
      ['get', '/api/v1/subscribers'],
      ['get', '/api/v1/chit-groups'],
      ['get', `/api/v1/chit-groups/${g.id}`],
      ['get', '/api/v1/collections/transactions'],
      ['get', `/api/v1/auctions/group/${g.id}`],
      ['get', `/api/v1/auctions/group/${g.id}/eligibility`],
      ['get', `${E}/groups/${g.id}/dues`],
      ['get', `${E}/sessions`],
      ['get', '/api/v1/financial-policies/effective'],
      ['get', '/api/v1/notifications'],
      ['post', '/api/v1/collections/pay'],
      ['get', '/api/v1/auth/users'],
    ] as const;
    for (const [method, path] of paths) {
      const r = await (api() as any)[method](path).set(bearer(mem1)).send({});
      expect([path, r.status, r.body.code]).toEqual([path, 403, 'MEMBER_SCOPE']);
    }
    expect((await api().get('/api/v1/auth/me').set(bearer(mem1))).status).toBe(200);
    // staff/managers cannot use the member API
    expect((await api().get('/api/v1/me/member/summary').set(bearer(A.managerToken))).status).toBe(403);
  });

  it('switching the portal off locks members out immediately (requests and login)', async () => {
    await api().patch(`${E}/companies/${A.company.id}/member-portal`).set(bearer(saToken)).send({ enabled: false });
    const r = await api().get('/api/v1/me/member/summary').set(bearer(mem1));
    expect([r.status, r.body.code]).toEqual([403, 'MEMBER_PORTAL_DISABLED']);
    const l = await api().post('/api/v1/auth/login').send({ usernameOrPhone: 'bala.member', password: PASSWORD });
    expect([l.status, l.body.code]).toEqual([403, 'MEMBER_PORTAL_DISABLED']);
  });
});
