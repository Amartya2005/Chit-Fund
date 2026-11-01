import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { api, bearer, createTenant, createUser, login, PASSWORD, prisma, recordCash, resetDb } from '../helpers.js';
import { E, activatePolicy, addMember, configureCompany, convertGroup, createGroup, enableEngine } from '../engine-helpers.js';
import { registerEngineRoutes } from '../../src/engine/routes.js';
import { todayInIndia } from '../../src/modules/subscribers/arrears.js';
import { addDays } from '../../src/finance/schedule/recurrence.js';

/** P10: route-level security sweep over every engine endpoint, cross-tenant access, reports. */
const today = todayInIndia();
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let saToken: string;
let memberToken: string;
const ids: Record<string, string> = {};

// every engine route, discovered from the router itself (new routes are covered automatically)
const routes: { method: string; path: string }[] = (() => {
  const r = express.Router();
  registerEngineRoutes(r);
  return r.stack.filter((l: any) => l.route).flatMap((l: any) => Object.keys(l.route.methods).map((method) => ({ method, path: l.route.path as string })));
})();
const CRON = '/engine/scheduler/cron';
const STAFF_ALLOWED = new Set(['get /engine/groups/:id/status', 'get /engine/groups/:id/dues', 'get /engine/payments/:id/allocations', 'get /engine/groups/:id/schedules', 'get /engine/sessions', 'get /engine/sessions/:id', 'get /engine/sessions/:id/live']);
const isMemberRoute = (p: string) => p.startsWith('/me/member') || p.startsWith('/engine/member/');
const isSuperAdminOnly = (p: string) => p.startsWith('/engine/companies/');
const call = (method: string, path: string, token?: string) => {
  const req = (api() as any)[method](`/api/v1${path}`);
  return (token ? req.set(bearer(token)) : req).send({});
};
function concrete(path: string) {
  const id = (k: string) => ids[k] ?? '00000000-0000-0000-0000-000000000000';
  return path
    .replace('/engine/companies/:id', `/engine/companies/${id('company')}`)
    .replace('/engine/groups/:id', `/engine/groups/${id('group')}`)
    .replace('/engine/payments/:id', `/engine/payments/${id('payment')}`)
    .replace('/engine/adjustments/:id', `/engine/adjustments/${id('adjustment')}`)
    .replace('/engine/schedules/:id', `/engine/schedules/${id('schedule')}`)
    .replace('/engine/member/sessions/:id', `/engine/member/sessions/${id('session')}`)
    .replace('/engine/sessions/:id', `/engine/sessions/${id('session')}`)
    .replace('/engine/settlements/:id', `/engine/settlements/${id('settlement')}`)
    .replace('/engine/accounting/periods/:id', `/engine/accounting/periods/${id('period')}`)
    .replace('/engine/members/:subscriberId', `/engine/members/${id('subscriber')}`)
    .replace('/engine/interest/accounts/:id', `/engine/interest/accounts/${id('loan')}`);
}

beforeAll(async () => {
  await resetDb();
  A = await createTenant('XA');
  B = await createTenant('XB');
  saToken = await login((await createUser('SUPER_ADMIN', null, 'p10sa')).username);
  const m2 = await login((await createUser('MANAGER', A.company.id, 'XA_m2')).username);
  await configureCompany(A.managerToken, saToken, A.company.id, { PENALTY: { mode: 'FLAT_PER_PERIOD', flatAmount: '100', graceDays: 0 } });
  await enableEngine(saToken, A.company.id);
  await api().patch(`${E}/companies/${A.company.id}/member-portal`).set(bearer(saToken)).send({ enabled: true });
  await api().patch(`${E}/companies/${A.company.id}/interest-engine`).set(bearer(saToken)).send({ enabled: true, attestation: 'TEST ONLY — enabled for automated security tests, no real legal sign-off.' });
  const g = await createGroup(A.managerToken, { name: 'Sweep group', chitValue: 40000, maxMembers: 4, totalMonths: 4, startDate: addDays(today, -65), assignedStaffId: A.staff.id });
  const subs = [A.subscriber];
  for (let i = 0; i < 4; i++) subs.push(await addMember(A.managerToken, g.id, `Sweep ${i}`, `950000000${i}`));
  await convertGroup(A.managerToken, g.id);
  const pay = await recordCash(A.managerToken, subs[1].id, g.id, 5000, 1);
  await api().post(`${E}/groups/${g.id}/penalties/run`).set(bearer(A.managerToken)).send({});
  const due = await prisma.memberDue.findFirstOrThrow({ where: { groupId: g.id, periodNo: 1, subscriberId: subs[2].id } });
  const adj = await api().post(`${E}/adjustments`).set(bearer(A.managerToken)).send({ type: 'PENALTY_WAIVER', dueId: due.id, amount: '50', reason: 'sweep' });
  const sch = await api().post(`${E}/groups/${g.id}/schedules`).set(bearer(A.managerToken)).send({ frequency: 'EXPLICIT_DATES', explicitDates: [addDays(today, 20)], startDate: today, opensAtLocal: '10:00', closesAtLocal: '11:00', holidayPolicy: 'IGNORE' });
  const s = await api().post(`${E}/groups/${g.id}/sessions`).set(bearer(A.managerToken)).send({ date: today, opensAtLocal: '00:01', closesAtLocal: '00:02' });
  for (const a of ['open', 'close']) await api().post(`${E}/sessions/${s.body.data.id}/${a}`).set(bearer(A.managerToken)).send({});
  const winner = await prisma.chitGroupMember.findFirstOrThrow({ where: { groupId: g.id, subscriberId: subs[3].id } });
  const st = await api().post(`${E}/sessions/${s.body.data.id}/result`).set(bearer(A.managerToken)).send({ winnerMemberId: winner.id, discount: '6000' });
  const period = await api().post(`${E}/accounting/periods`).set(bearer(A.managerToken)).send({ name: 'Old', startDate: '2020-01-01', endDate: '2020-12-31' });
  await api().post(`${E}/interest/products`).set(bearer(A.managerToken)).send({ code: 'L1', name: 'test', terms: { method: 'REDUCING_BALANCE', annualRatePercent: '12', penalRatePercent: 'NONE', graceDays: 0, lateFee: 'NONE', prepayment: { allowed: false }, waterfall: ['LATE_FEE', 'PENAL', 'INTEREST', 'PRINCIPAL'] } });
  const loan = await api().post(`${E}/interest/accounts`).set(bearer(A.managerToken)).send({ subscriberId: subs[4].id, productCode: 'L1', principal: '10000', termMonths: 2, firstDueDate: addDays(today, 30) });
  await api().post(`${E}/members/${subs[1].id}/login`).set(bearer(A.managerToken)).send({ username: 'sweep.member', password: PASSWORD });
  memberToken = await login('sweep.member');
  Object.assign(ids, {
    company: A.company.id, group: g.id, payment: pay.body.data.id, adjustment: adj.body.data.id, schedule: sch.body.data.schedule.id,
    session: s.body.data.id, settlement: st.body.data.id, period: period.body.data.id, subscriber: subs[4].id, loan: loan.body.data.id,
  });
  void m2;
});

describe('P10 — every engine route is protected', () => {
  it('discovers at least 60 engine routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(60);
  });
  it('no route works without a token', async () => {
    for (const r of routes) {
      const res = await call(r.method, concrete(r.path));
      expect([`${r.method} ${r.path}`, res.status]).toEqual([`${r.method} ${r.path}`, 401]);
    }
  });
  it('collection staff reach only the read endpoints meant for them', async () => {
    for (const r of routes.filter((x) => x.path !== CRON)) {
      const res = await call(r.method, concrete(r.path), A.staffToken);
      const key = `${r.method} ${r.path}`;
      if (STAFF_ALLOWED.has(key)) expect([key, [401, 403].includes(res.status)]).toEqual([key, false]);
      else expect([key, res.status]).toEqual([key, 403]);
    }
  });
  it('members reach only the member area', async () => {
    for (const r of routes.filter((x) => x.path !== CRON)) {
      const res = await call(r.method, concrete(r.path), memberToken);
      const key = `${r.method} ${r.path}`;
      if (isMemberRoute(r.path)) expect([key, res.status === 403 && res.body.code === 'MEMBER_SCOPE']).toEqual([key, false]);
      else expect([key, res.status]).toEqual([key, 403]);
    }
  });
  it('another company’s manager gets 404 (or 403 for admin/member-only routes) and changes nothing', async () => {
    const before = await Promise.all([
      prisma.auctionSettlement.findUniqueOrThrow({ where: { id: ids.settlement } }),
      prisma.financialAdjustment.findUniqueOrThrow({ where: { id: ids.adjustment } }),
      prisma.auctionSchedule.findUniqueOrThrow({ where: { id: ids.schedule } }),
      prisma.interestAccount.findUniqueOrThrow({ where: { id: ids.loan } }),
      prisma.financialPeriod.findUniqueOrThrow({ where: { id: ids.period } }),
    ]);
    expect((await call('post', CRON, B.managerToken)).status).toBe(401); // cron: secret header only
    for (const r of routes.filter((x) => x.path.includes(':'))) {
      const res = await call(r.method, concrete(r.path), B.managerToken);
      const key = `${r.method} ${r.path}`;
      const expected = isSuperAdminOnly(r.path) || isMemberRoute(r.path) ? 403 : 404;
      expect([key, res.status]).toEqual([key, expected]);
    }
    const after = await Promise.all([
      prisma.auctionSettlement.findUniqueOrThrow({ where: { id: ids.settlement } }),
      prisma.financialAdjustment.findUniqueOrThrow({ where: { id: ids.adjustment } }),
      prisma.auctionSchedule.findUniqueOrThrow({ where: { id: ids.schedule } }),
      prisma.interestAccount.findUniqueOrThrow({ where: { id: ids.loan } }),
      prisma.financialPeriod.findUniqueOrThrow({ where: { id: ids.period } }),
    ]);
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
    // list endpoints only show the caller's own company
    for (const p of ['/engine/sessions', '/engine/adjustments', '/engine/accounting/events', '/engine/reports/auctions', '/engine/reports/arrears']) {
      const res = await call('get', p, B.managerToken);
      expect([p, JSON.stringify(res.body.data).includes(ids.group)]).toEqual([p, false]);
    }
  });
});

describe('P10 — reports', () => {
  it('auctions report: settled results with totals that add up', async () => {
    await api().post(`${E}/settlements/${ids.settlement}/approve`).set(bearer(await login('manager_XA_m2'))).send({});
    const r = await api().get(`${E}/reports/auctions`).set(bearer(A.managerToken));
    expect(r.body.data.count).toBe(1);
    const t = r.body.data.totals;
    // A1: discount = commission + pool; prize = chit value − discount
    expect(Number(t.winningDiscount)).toBe(Number(t.commission) + Number(t.dividendPool));
    expect(Number(t.dividendPool)).toBe(Number(t.dividendCredited) + Number(t.dividendUnallocated));
    expect(t).toMatchObject({ winningDiscount: '6000.00', commission: '2000.00', grossPrize: '34000.00' });
  });
  it('arrears report ages overdue dues; totals equal the sum of tickets', async () => {
    const r = await api().get(`${E}/reports/arrears?asOf=${today}`).set(bearer(A.managerToken));
    const sum = r.body.data.rows.reduce((s: number, x: any) => s + Math.round(Number(x.overdue) * 100), 0);
    expect(sum).toBe(Math.round(Number(r.body.data.totals.overdue) * 100));
    expect(Number(r.body.data.totals['61-90'])).toBeGreaterThan(0); // instalment #1 is ~65 days old
  });
  it('pending decisions: vacant-seat dividend kept aside and unposted events are listed', async () => {
    const r = await api().get(`${E}/reports/pending-decisions`).set(bearer(A.managerToken));
    expect(r.body.data.engineDividends).toEqual([]); // all 4 seats filled: the whole pool was credited
    expect(r.body.data.unpostedEvents.find((x: any) => x.reason === 'NO_LEDGER_CUTOVER').count).toBeGreaterThan(0);
  });
  it('ledger statements balance after posting', async () => {
    await api().put(`${E}/accounting/cutover`).set(bearer(A.managerToken)).send({ date: '2020-01-01' });
    await api().get('/api/v1/accounting/accounts').set(bearer(A.managerToken));
    for (const [code, name] of [['2003', 'Chit Group Pool'], ['2004', 'Dividend Payable'], ['2005', 'Dividend Unallocated'], ['1300', 'Loans Receivable'], ['4005', 'Interest Income']]) {
      await api().post('/api/v1/accounting/accounts').set(bearer(A.managerToken)).send({ code, name, type: code.startsWith('1') ? 'ASSET' : code.startsWith('4') ? 'INCOME' : 'LIABILITY' });
    }
    const accounts = (await api().get('/api/v1/accounting/accounts').set(bearer(A.managerToken))).body.data as any[];
    const id = (c: string) => accounts.find((a) => a.code === c).id;
    await api().put(`${E}/accounting/mappings`).set(bearer(A.managerToken)).send({ mappings: {
      CASH: id('1001'), BANK: id('1002'), SUBSCRIBER_RECEIVABLE: id('1100'), SUBSCRIBER_ADVANCE: id('2002'), PRIZE_PAYABLE: id('2001'), COMMISSION_INCOME: id('4001'),
      PENALTY_INCOME: id('4002'), FEE_INCOME: id('4003'), CHIT_POOL_PAYABLE: id('2003'), DIVIDEND_PAYABLE: id('2004'), DIVIDEND_UNALLOCATED: id('2005'), LOAN_RECEIVABLE: id('1300'), INTEREST_INCOME: id('4005'),
    } });
    const run = await api().post(`${E}/accounting/run`).set(bearer(A.managerToken)).send({});
    expect(run.body.data.results.POSTED).toBeGreaterThan(0);
    const st = await api().get(`${E}/accounting/statements`).set(bearer(A.managerToken));
    expect(st.body.data.balanceSheet.balanced).toBe(true);
    expect(Number(st.body.data.profitAndLoss.totalIncome)).toBeGreaterThan(0); // commission + penalties
    const tb = await api().get(`${E}/accounting/trial-balance`).set(bearer(A.managerToken));
    expect(tb.body.data.isBalanced).toBe(true);
  });
});
