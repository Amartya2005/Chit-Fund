import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createTenant, createUser, login, prisma, recordCash, resetDb } from '../helpers.js';
import { E, P, activatePolicy, addMember, configureCompany, convertGroup, createGroup, enableEngine } from '../engine-helpers.js';

/**
 * P3: per-ticket dues, payment allocation, penalties, waivers and legacy-group conversion.
 * Group: ₹1,00,000, 10 seats, 10 monthly instalments of ₹10,000 from 2026-01-05.
 */
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let saToken: string;
let manager2Token: string;
const subs: any[] = [];
const gid = () => A.group.id;
const dues = (q = '') => api().get(`${E}/groups/${gid()}/dues${q}`).set(bearer(A.managerToken));
const ticket = (body: any, subscriberId: string) => body.data.tickets.find((t: any) => t.subscriber.id === subscriberId);

beforeAll(async () => {
  await resetDb();
  A = await createTenant('DA');
  B = await createTenant('DB');
  const sa = await createUser('SUPER_ADMIN', null, 'p3sa');
  saToken = await login(sa.username);
  const m2 = await createUser('MANAGER', A.company.id, 'DA_m2');
  manager2Token = await login(m2.username);
  subs.push(A.subscriber);
  subs.push(await addMember(A.managerToken, gid(), 'Ravi', '9000000102'));
  subs.push(await addMember(A.managerToken, gid(), 'Sita', '9000000103'));
  subs.push(await addMember(A.managerToken, gid(), 'Kumar', '9000000104'));

  // legacy history before conversion
  expect((await recordCash(A.managerToken, subs[0].id, gid(), 10000, 1)).status).toBe(201); // full
  expect((await recordCash(A.managerToken, subs[1].id, gid(), 4000, 1)).status).toBe(201); // partial
  const rev = await recordCash(A.managerToken, subs[2].id, gid(), 500, 1);
  expect((await api().post(`/api/v1/collections/${rev.body.data.id}/reverse`).set(bearer(A.managerToken)).send({ reason: 'wrong member' })).status).toBe(200);
  expect((await recordCash(A.staffToken, subs[3].id, gid(), 10000, 1)).status).toBe(201); // pending verification
  const auction = await api().post('/api/v1/auctions/confirm').set(bearer(A.managerToken)).send({ groupId: gid(), installmentNo: 1, auctionDate: '2026-01-20', winningBidDiscount: 15000, winnerSubscriberId: subs[0].id });
  expect(auction.status).toBe(201); // ₹1,000 per seat credited to instalment #2 (4 active of 10 seats)
  expect((await recordCash(A.managerToken, subs[0].id, gid(), 12000, 2)).status).toBe(201); // net 9,000 → 3,000 advance
});

describe('P3 — conversion preconditions', () => {
  it('refuses without the company engine flag, with incomplete settings, and for staff / other tenants', async () => {
    const r1 = await api().post(`${E}/groups/${gid()}/convert`).set(bearer(A.managerToken)).send({});
    expect([r1.status, r1.body.code]).toEqual([409, 'ENGINE_NOT_ENABLED']);
    await enableEngine(saToken, A.company.id);
    const r2 = await api().post(`${E}/groups/${gid()}/convert`).set(bearer(A.managerToken)).send({});
    expect([r2.status, r2.body.code]).toEqual([422, 'CONFIG_NOT_READY']);
    expect(r2.body.details.missing).toContain('contribution.paymentAllocation');
    expect((await api().post(`${E}/groups/${gid()}/convert`).set(bearer(A.staffToken)).send({ dryRun: true })).status).toBe(403);
    expect((await api().post(`${E}/groups/${gid()}/convert`).set(bearer(B.managerToken)).send({ dryRun: true })).status).toBe(404);
    expect((await api().patch(`${E}/companies/${A.company.id}/settings`).set(bearer(A.managerToken)).send({ engineEnabled: true })).status).toBe(403);
  });
});

describe('P3 — dry run reconciliation and conversion', () => {
  it('dry run reports exactly how legacy history is carried over, without writing anything', async () => {
    await configureCompany(A.managerToken, saToken, A.company.id, { PENALTY: { mode: 'FLAT_PER_PERIOD', flatAmount: '100', graceDays: 5 } });
    const r = await api().post(`${E}/groups/${gid()}/convert`).set(bearer(A.managerToken)).send({ dryRun: true });
    expect(r.status).toBe(200);
    const rep = r.body.data.report;
    expect(r.body.data.canConvert).toBe(true);
    expect(rep.periods).toBe(10);
    expect(rep.tickets).toEqual({ active: 4, notActive: 0 });
    expect(rep.payments).toEqual({
      verifiedCount: 3,
      verifiedTotal: '26000.00',
      allocatedToDues: '23000.00', // 10,000 + 4,000 + 9,000
      advance: '3000.00',
      exitedTickets: '0.00',
      excludedPending: 1,
      excludedRejectedOrReversed: 1,
    });
    expect(rep.dividends).toEqual({ creditedTotal: '4000.00', checkedAgainstAuctionRecords: 1, legacyAuctionsWithoutDetail: 0 });
    expect(rep.pendingDividendDecisions).toEqual({ count: 1, total: '6000.00' }); // 6 vacant seats
    expect(rep.reconciled).toBe(true);
    expect(await prisma.memberDue.count()).toBe(0);
  });

  it('converts: periods, dues, allocations, snapshot and permanent report; second conversion refused', async () => {
    const d = await convertGroup(A.managerToken, gid());
    expect(d.report.reconciled).toBe(true);
    expect(await prisma.contributionPeriod.count({ where: { groupId: gid() } })).toBe(10);
    expect(await prisma.memberDue.count({ where: { groupId: gid() } })).toBe(40);
    expect((await prisma.chitGroup.findUniqueOrThrow({ where: { id: gid() } })).engineVersion).toBe('ENGINE_V1');
    expect(await prisma.configSnapshot.count({ where: { subjectType: 'GROUP_ACTIVATION', subjectId: gid() } })).toBe(1);
    const status = await api().get(`${E}/groups/${gid()}/status`).set(bearer(A.staffToken));
    expect(status.body.data).toMatchObject({ engineVersion: 'ENGINE_V1', conversion: { snapshotId: expect.any(String) } });
    const again = await api().post(`${E}/groups/${gid()}/convert`).set(bearer(A.managerToken)).send({});
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_CONVERTED']);
  });

  it('dues as of a date: due today is DUE, earlier unpaid is OVERDUE, future is UPCOMING; advance shown', async () => {
    const r = await dues('?asOf=2026-02-05');
    const t0 = ticket(r.body, subs[0].id);
    expect(t0.advance).toBe('3000.00');
    expect(t0.dues.slice(0, 3).map((x: any) => [x.periodNo, x.netAmount, x.paidAmount, x.status])).toEqual([
      [1, '10000.00', '10000.00', 'PAID'],
      [2, '9000.00', '9000.00', 'PAID'],
      [3, '10000.00', '0.00', 'UPCOMING'],
    ]);
    const t1 = ticket(r.body, subs[1].id);
    expect(t1.dues.slice(0, 2).map((x: any) => [x.status, x.outstanding])).toEqual([
      ['PARTIAL', '6000.00'],
      ['DUE', '9000.00'],
    ]);
    expect(t1.totals).toMatchObject({ overdue: '6000.00', dueToday: '9000.00', overdueCount: 1 });
  });
});

describe('P3 — payments after conversion', () => {
  it('a verified payment is applied per the policy (TAGGED_PERIOD) and the rest kept as advance', async () => {
    const p = await recordCash(A.managerToken, subs[1].id, gid(), 7000, 1);
    expect(p.status).toBe(201);
    const al = await api().get(`${E}/payments/${p.body.data.id}/allocations`).set(bearer(A.managerToken));
    expect(al.body.data.map((a: any) => [a.bucket, a.periodNo, a.amount])).toEqual([
      ['DUE', 1, '6000.00'],
      ['ADVANCE', null, '1000.00'],
    ]);
  });

  it('OLDEST_FIRST spreads a payment across open dues', async () => {
    await activatePolicy(A.managerToken, { scope: 'GROUP', groupId: gid(), kind: 'CONTRIBUTION', values: { paymentAllocation: 'OLDEST_FIRST' } });
    const p = await recordCash(A.managerToken, subs[2].id, gid(), 15000, 5);
    const al = await api().get(`${E}/payments/${p.body.data.id}/allocations`).set(bearer(A.managerToken));
    expect(al.body.data.map((a: any) => [a.periodNo, a.amount])).toEqual([
      [1, '10000.00'],
      [2, '5000.00'],
    ]);
  });

  it('staff receipts are applied only when approved; reversal undoes the allocation', async () => {
    const pending = await prisma.paymentTransaction.findFirstOrThrow({ where: { groupId: gid(), verificationStatus: 'PENDING_VERIFICATION' } });
    expect(await prisma.paymentAllocation.count({ where: { paymentId: pending.id } })).toBe(0);
    expect((await api().post(`/api/v1/collections/${pending.id}/approve`).set(bearer(A.managerToken)).send({})).status).toBe(200);
    const due1 = await prisma.memberDue.findFirstOrThrow({ where: { groupId: gid(), subscriberId: subs[3].id, periodNo: 1 } });
    expect(due1.paidAmount.toFixed(2)).toBe('10000.00');
    expect((await api().post(`/api/v1/collections/${pending.id}/reverse`).set(bearer(A.managerToken)).send({ reason: 'cheque bounced' })).status).toBe(200);
    const after = await prisma.memberDue.findUniqueOrThrow({ where: { id: due1.id } });
    expect(after.paidAmount.toFixed(2)).toBe('0.00');
    const rows = await prisma.paymentAllocation.findMany({ where: { paymentId: pending.id } });
    expect(rows.every((r) => r.reversedAt !== null)).toBe(true);
  });

  it('invariant: every verified payment is fully allocated (dues + advance) exactly once', async () => {
    const pays = await prisma.paymentTransaction.findMany({ where: { groupId: gid(), verificationStatus: 'VERIFIED', isReversed: false }, include: { allocations: { where: { reversedAt: null } } } });
    for (const p of pays) {
      const total = p.allocations.reduce((s, a) => s + Math.round(Number(a.amount) * 100), 0);
      expect(total, p.receiptNo).toBe(Math.round(Number(p.amount) * 100));
    }
    // paidAmount on dues equals the live allocations to them
    const ds = await prisma.memberDue.findMany({ where: { groupId: gid() }, include: { allocations: { where: { reversedAt: null } } } });
    for (const d of ds) expect(Math.round(Number(d.paidAmount) * 100)).toBe(d.allocations.reduce((s, a) => s + Math.round(Number(a.amount) * 100), 0));
  });

  it('the legacy auction endpoint refuses engine groups', async () => {
    const r = await api().post('/api/v1/auctions/confirm').set(bearer(A.managerToken)).send({ groupId: gid(), installmentNo: 2, auctionDate: '2026-02-20', winningBidDiscount: 12000, winnerSubscriberId: subs[1].id });
    expect([r.status, r.body.code]).toEqual([409, 'ENGINE_GROUP_USE_SESSIONS']);
  });
});

describe('P3 — penalties (test rule: ₹100 flat per missed period after 5 grace days)', () => {
  it('charges once per overdue due; concurrent and repeated runs do not double charge; no future dates', async () => {
    const run = () => api().post(`${E}/groups/${gid()}/penalties/run`).set(bearer(A.managerToken)).send({ asOf: '2026-02-11' });
    const results = await Promise.all([run(), run(), run()]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const charges = await prisma.penaltyCharge.findMany({ where: { due: { groupId: gid() } }, include: { due: true } });
    // on 2026-02-11 instalments #1 (due 01-05) and #2 (due 02-05, grace ends 02-10) are past grace
    const byPeriod = charges.map((c) => `${c.due.periodNo}:${c.amount.toFixed(2)}`).sort();
    expect(results.reduce((s, r) => s + r.body.data.charged.length, 0)).toBe(charges.length);
    expect(byPeriod.every((x) => x.endsWith(':100.00'))).toBe(true);
    // ticket 4 (reversed payment) owes #1 and #2; ticket 2 owes #2 (partly paid); ticket 1 & 3 paid #1 and #2 in full / part
    const perTicket = (sid: string) => charges.filter((c) => c.due.subscriberId === sid).map((c) => c.due.periodNo).sort();
    expect(perTicket(subs[3].id)).toEqual([1, 2]);
    expect(perTicket(subs[0].id)).toEqual([]);
    expect((await run()).body.data.charged).toEqual([]);
    const future = await api().post(`${E}/groups/${gid()}/penalties/run`).set(bearer(A.managerToken)).send({ asOf: '2099-01-01' });
    expect(future.status).toBe(400);
  });
});

describe('P3 — waivers with a second approver (test choice adjustmentApproval = SECOND_PERSON)', () => {
  it('request → same person cannot approve → second manager approves → due reduced', async () => {
    const due = await prisma.memberDue.findFirstOrThrow({ where: { groupId: gid(), subscriberId: subs[3].id, periodNo: 1 } });
    const tooBig = await api().post(`${E}/adjustments`).set(bearer(A.managerToken)).send({ type: 'PENALTY_WAIVER', dueId: due.id, amount: '100.01', reason: 'x' });
    expect([tooBig.status, tooBig.body.code]).toEqual([422, 'WAIVER_TOO_LARGE']);
    const r = await api().post(`${E}/adjustments`).set(bearer(A.managerToken)).send({ type: 'PENALTY_WAIVER', dueId: due.id, amount: '100', reason: 'first delay, waived' });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('REQUESTED');
    expect((await prisma.memberDue.findUniqueOrThrow({ where: { id: due.id } })).penaltyWaived.toFixed(2)).toBe('0.00');
    const same = await api().post(`${E}/adjustments/${r.body.data.id}/approve`).set(bearer(A.managerToken)).send({});
    expect([same.status, same.body.code]).toEqual([403, 'SAME_PERSON']);
    const ok = await api().post(`${E}/adjustments/${r.body.data.id}/approve`).set(bearer(manager2Token)).send({ note: 'agreed' });
    expect(ok.body.data.status).toBe('APPLIED');
    expect((await prisma.memberDue.findUniqueOrThrow({ where: { id: due.id } })).penaltyWaived.toFixed(2)).toBe('100.00');
    expect((await api().post(`${E}/adjustments/${r.body.data.id}/approve`).set(bearer(manager2Token)).send({})).status).toBe(409);
    expect((await api().post(`${E}/adjustments/${r.body.data.id}/approve`).set(bearer(B.managerToken)).send({})).status).toBe(404);
  });
});

describe('P3 — protections', () => {
  it('a settings version may not leave an engine group without a decision it uses', async () => {
    const c = await api().post(P).set(bearer(A.managerToken)).send({ scope: 'COMPANY', kind: 'CONTRIBUTION', values: { rounding: 'PAISE_HALF_UP' } });
    expect([c.status, c.body.code]).toEqual([422, 'POLICY_INCONSISTENT']);
    expect(c.body.details.violations.map((v: any) => v.code)).toContain('ENGINE_GROUP_DECISION_REMOVED');
  });
  it('engine groups and members with dues cannot be deleted; allocations and penalties are append-only', async () => {
    expect((await api().delete(`/api/v1/chit-groups/${gid()}`).set(bearer(A.managerToken))).status).toBe(400);
    // an engine group without payments is refused by the engine guard itself
    const empty = await createGroup(A.managerToken, { name: 'Empty engine group', chitValue: 20000, maxMembers: 2, totalMonths: 2, startDate: '2027-03-01' });
    await addMember(A.managerToken, empty.id, 'Empty One', '9000000301');
    await convertGroup(A.managerToken, empty.id);
    expect((await api().delete(`/api/v1/chit-groups/${empty.id}`).set(bearer(A.managerToken))).body.code).toBe('ENGINE_HISTORY');
    expect(await prisma.chitGroup.count({ where: { id: empty.id } })).toBe(1);
    const alloc = await prisma.paymentAllocation.findFirstOrThrow({ where: { reversedAt: null } });
    await expect(prisma.$executeRawUnsafe(`UPDATE "PaymentAllocation" SET amount = 1 WHERE id = '${alloc.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "PaymentAllocation" WHERE id = '${alloc.id}'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "PenaltyCharge" SET amount = 1`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "MemberDue" SET "dividendCredit" = "grossAmount" + 1 WHERE "groupId" = '${gid()}'`)).rejects.toThrow(/check/i);
  });
  it('cross-tenant access to dues, allocations and adjustments → 404', async () => {
    expect((await api().get(`${E}/groups/${gid()}/dues`).set(bearer(B.managerToken))).status).toBe(404);
    const pay = await prisma.paymentAllocation.findFirstOrThrow();
    expect((await api().get(`${E}/payments/${pay.paymentId}/allocations`).set(bearer(B.managerToken))).status).toBe(404);
    expect((await api().get(`${E}/adjustments`).set(bearer(B.managerToken))).body.data).toEqual([]);
    expect((await api().get(`${E}/groups/${B.group.id}/dues`).set(bearer(B.managerToken))).body.code).toBe('NOT_ENGINE_GROUP');
  });
});

describe('P3 — surrender in an engine group', () => {
  it('future unpaid dues of the exited ticket are removed; paid history stays', async () => {
    const g = await createGroup(A.managerToken, { name: 'Future group', chitValue: 50000, maxMembers: 5, totalMonths: 5, startDate: '2027-01-10' });
    const s1 = await addMember(A.managerToken, g.id, 'Future One', '9000000201');
    await addMember(A.managerToken, g.id, 'Future Two', '9000000202');
    await convertGroup(A.managerToken, g.id);
    expect((await recordCash(A.managerToken, s1.id, g.id, 10000, 1)).status).toBe(201);
    const refund = await api().post('/api/v1/refunds').set(bearer(A.managerToken)).send({ subscriberId: s1.id, groupId: g.id, amount: 1000, reason: 'Moving away' });
    expect((await api().patch(`/api/v1/refunds/${refund.body.data.id}/process`).set(bearer(A.managerToken)).send({ status: 'APPROVED' })).status).toBe(200);
    const left = await prisma.memberDue.findMany({ where: { groupId: g.id, subscriberId: s1.id } });
    expect(left.map((d) => d.periodNo)).toEqual([1]); // the paid one is kept
    expect(await prisma.memberDue.count({ where: { groupId: g.id } })).toBe(1 + 5);
  });
});
