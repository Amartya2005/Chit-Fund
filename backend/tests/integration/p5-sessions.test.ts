import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createTenant, createUser, login, prisma, resetDb } from '../helpers.js';
import { E, activatePolicy, addMember, configureCompany, convertGroup, createGroup, enableEngine } from '../engine-helpers.js';
import { todayInIndia } from '../../src/modules/subscribers/arrears.js';
import { addDays } from '../../src/finance/schedule/recurrence.js';

/**
 * P5 (schedules, sessions, settlement, reversal, approvals, payouts) and P6 (eligibility, overrides).
 * G1: ₹1,00,000, 10 seats, 10 monthly instalments starting in 3 days → FINANCIAL_ENGINE A-2.
 * G2: ₹60,000, 6 seats, started 45 days ago → two instalments overdue for everybody.
 */
const today = todayInIndia();
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let saToken: string;
let m2Token: string;
let g1: any, g2: any;
const t1: any[] = []; // G1 tickets (members with subscribers)
const t2: any[] = [];
let s1: any, s2: any;

const sessions = async (groupId: string) => (await api().get(`${E}/sessions?groupId=${groupId}`).set(bearer(A.managerToken))).body.data;
const act = (id: string, action: string, body: any = {}, token = A.managerToken) => api().post(`${E}/sessions/${id}/${action}`).set(bearer(token)).send(body);
const members = (groupId: string) => prisma.chitGroupMember.findMany({ where: { groupId }, orderBy: { ticketNumber: 'asc' } });

beforeAll(async () => {
  await resetDb();
  A = await createTenant('SA');
  B = await createTenant('SB');
  saToken = await login((await createUser('SUPER_ADMIN', null, 'p5sa')).username);
  m2Token = await login((await createUser('MANAGER', A.company.id, 'SA_m2')).username);
  await configureCompany(A.managerToken, saToken, A.company.id);
  await enableEngine(saToken, A.company.id);
  g1 = await createGroup(A.managerToken, { name: 'Session group', chitValue: 100000, maxMembers: 10, totalMonths: 10, startDate: addDays(today, 3) });
  for (let i = 0; i < 10; i++) await addMember(A.managerToken, g1.id, `G1 Member ${i + 1}`, `9100000${String(i).padStart(3, '0')}`);
  await convertGroup(A.managerToken, g1.id);
  t1.push(...(await members(g1.id)));
  g2 = await createGroup(A.managerToken, { name: 'Overdue group', chitValue: 60000, maxMembers: 6, totalMonths: 6, startDate: addDays(today, -45) });
  for (let i = 0; i < 6; i++) await addMember(A.managerToken, g2.id, `G2 Member ${i + 1}`, `9200000${String(i).padStart(3, '0')}`);
  await convertGroup(A.managerToken, g2.id);
  t2.push(...(await members(g2.id)));
});

describe('P5 — schedules materialise sessions idempotently', () => {
  it('explicit dates with a holiday moved to the next business day; reruns and parallel runs never duplicate', async () => {
    expect((await api().post(`${E}/holidays`).set(bearer(A.managerToken)).send({ date: addDays(today, 40), name: 'Festival' })).status).toBe(201);
    const r = await api().post(`${E}/groups/${g1.id}/schedules`).set(bearer(A.managerToken)).send({
      frequency: 'EXPLICIT_DATES', explicitDates: [addDays(today, 10), addDays(today, 40)], startDate: today, opensAtLocal: '18:00', closesAtLocal: '19:00', holidayPolicy: 'NEXT_BUSINESS_DAY',
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ planned: 2, materialized: 2, warnings: [] });
    await Promise.all([1, 2, 3].map(() => api().post(`${E}/scheduler/run`).set(bearer(A.managerToken)).send({})));
    const list = await sessions(g1.id);
    expect(list.map((s: any) => [s.sequenceNo, s.occurrenceKey, s.scheduledDate, s.status, s.mode])).toEqual([
      [1, addDays(today, 10), addDays(today, 10), 'SCHEDULED', 'OFFLINE'],
      [2, addDays(today, 40), addDays(today, 41), 'SCHEDULED', 'OFFLINE'],
    ]);
    expect(new Date(list[0].opensAt).toISOString()).toBe(new Date(`${addDays(today, 10)}T18:00:00+05:30`).toISOString());
    [s1, s2] = list;
  });
  it('schedules need an end (no open-ended calendars) and explicit times / holiday policy', async () => {
    const r = await api().post(`${E}/groups/${g1.id}/schedules`).set(bearer(A.managerToken)).send({ frequency: 'DAILY', startDate: today, opensAtLocal: '10:00', closesAtLocal: '11:00', holidayPolicy: 'SKIP' });
    expect(r.status).toBe(400);
    const r2 = await api().post(`${E}/groups/${g1.id}/schedules`).set(bearer(A.managerToken)).send({ frequency: 'DAILY', startDate: today, maxOccurrences: 2, opensAtLocal: '10:00', closesAtLocal: '11:00' });
    expect(r2.body.message).toMatch(/holidayPolicy/);
  });
});

describe('P5 — offline auction: open → close → result → settled (A-2)', () => {
  it('result entry is refused until the auction is closed; preview computes without writing', async () => {
    expect((await act(s1.id, 'open')).body.data.status).toBe('OPEN');
    expect((await act(s1.id, 'result', { winnerMemberId: t1[0].id, discount: '15000' })).body.code).toBe('INVALID_STATE');
    expect((await act(s1.id, 'close')).body.data.status).toBe('CLOSED');
    const bad = await act(s1.id, 'preview', { winnerMemberId: t1[0].id, discount: '4000' });
    expect(bad.body.data.outcome.errors.map((e: any) => e.code)).toEqual(['COMMISSION_EXCEEDS_DISCOUNT']);
    const p = await act(s1.id, 'preview', { winnerMemberId: t1[0].id, discount: '15000' });
    expect(p.body.data).toMatchObject({ valid: true, approvalNeeded: false, targetPeriodNo: 2 });
    expect(p.body.data.outcome).toMatchObject({ commission: '5000.00', dividendPool: '10000.00', dividendPerShare: '1000.00', grossPrize: '85000.00', netPrize: '85000.00' });
    expect(await prisma.auctionSettlement.count()).toBe(0);
  });

  it('only one of several parallel result submissions wins', async () => {
    const res = await Promise.all([1, 2, 3, 4].map(() => act(s1.id, 'result', { winnerMemberId: t1[0].id, discount: '15000' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it('settlement: dues credited, legacy projections, frozen config, reproducible calculation, events', async () => {
    const st = await prisma.auctionSettlement.findFirstOrThrow({ where: { sessionId: s1.id } });
    expect(st.status).toBe('SETTLED');
    const dues = await prisma.memberDue.findMany({ where: { groupId: g1.id, periodNo: 2 } });
    expect(dues.map((d) => d.dividendCredit.toFixed(2))).toEqual(Array(10).fill('1000.00'));
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: st.auctionId! }, include: { payout: true } });
    expect([auction.installmentNo, auction.winnerMemberId, auction.payout!.status, Number(auction.payout!.netPayoutAmount)]).toEqual([1, t1[0].id, 'PENDING', 85000]);
    const sched = await prisma.installmentSchedule.findUniqueOrThrow({ where: { groupId_installmentNo: { groupId: g1.id, installmentNo: 2 } } });
    expect([Number(sched.dividendAmount), Number(sched.netDueAmount)]).toEqual([1000, 9000]);
    const session = await prisma.auctionSession.findUniqueOrThrow({ where: { id: s1.id } });
    expect(session.status).toBe('SETTLED');
    expect(await prisma.configSnapshot.count({ where: { id: session.configSnapshotId! } })).toBe(1);
    const detail = await api().get(`${E}/settlements/${st.id}`).set(bearer(A.managerToken));
    expect(detail.body.data.reproducible).toEqual({ reproducible: true });
    const ev = await prisma.financialEvent.findMany({ where: { sourceId: st.id }, orderBy: { type: 'asc' } });
    expect(ev.map((e) => [e.type, e.amount.toFixed(2), e.postingStatus])).toEqual([
      ['AUCTION_SETTLED', '100000.00', 'NOT_POSTED'],
      ['DIVIDEND_APPLIED', '10000.00', 'NOT_POSTED'],
    ]);
  });

  it('the winner cannot win again (test rule maxWinsPerTicket = 1) and that rule cannot be overridden', async () => {
    await act(s2.id, 'open');
    await act(s2.id, 'close');
    const r = await act(s2.id, 'result', { winnerMemberId: t1[0].id, discount: '12000' });
    expect([r.status, r.body.code]).toEqual([422, 'WINNER_NOT_ELIGIBLE']);
    const o = await act(s2.id, 'eligibility/override', { memberId: t1[0].id, reason: 'try' });
    expect([o.status, o.body.code]).toEqual([403, 'NOT_OVERRIDABLE']);
  });
});

describe('P5 — approvals, reversal, re-settlement', () => {
  it('second-person approval (test choice via group policy) — submitter cannot approve', async () => {
    await activatePolicy(A.managerToken, { scope: 'GROUP', groupId: g1.id, kind: 'SETTLEMENT', values: { settlementApproval: 'SECOND_PERSON' } });
    // session 2 locks its configuration at result entry (test lockPoint AT_RESULT_ENTRY) → picks up SECOND_PERSON
    const r = await act(s2.id, 'result', { winnerMemberId: t1[1].id, discount: '12000' });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('PENDING_APPROVAL');
    expect((await prisma.memberDue.findFirstOrThrow({ where: { groupId: g1.id, periodNo: 3 } })).dividendCredit.toFixed(2)).toBe('0.00');
    expect((await api().post(`${E}/settlements/${r.body.data.id}/approve`).set(bearer(A.managerToken)).send({})).body.code).toBe('SAME_PERSON');
    const ok = await api().post(`${E}/settlements/${r.body.data.id}/approve`).set(bearer(m2Token)).send({ note: 'checked' });
    expect(ok.body.data.status).toBe('SETTLED');
    // 12,000 − 5,000 = 7,000 → ₹700 per seat to period #3
    expect((await prisma.memberDue.findFirstOrThrow({ where: { groupId: g1.id, periodNo: 3 } })).dividendCredit.toFixed(2)).toBe('700.00');
  });

  it('reversal: only the latest settled result, only while its payout is pending; history kept, dues and projections undone', async () => {
    const first = await prisma.auctionSettlement.findFirstOrThrow({ where: { sessionId: s1.id } });
    expect((await api().post(`${E}/settlements/${first.id}/reverse`).set(bearer(A.managerToken)).send({ reason: 'x' })).body.code).toBe('LATER_SETTLEMENT_EXISTS');
    const second = await prisma.auctionSettlement.findFirstOrThrow({ where: { sessionId: s2.id, status: 'SETTLED' } });
    const r = await api().post(`${E}/settlements/${second.id}/reverse`).set(bearer(A.managerToken)).send({ reason: 'wrong winner entered' });
    expect(r.body.data.status).toBe('REVERSED');
    expect((await prisma.memberDue.findFirstOrThrow({ where: { groupId: g1.id, periodNo: 3 } })).dividendCredit.toFixed(2)).toBe('0.00');
    expect(await prisma.auction.count({ where: { id: second.auctionId! } })).toBe(0);
    expect((await prisma.auctionSession.findUniqueOrThrow({ where: { id: s2.id } })).status).toBe('CLOSED');
    expect(await prisma.dividendRecord.count({ where: { settlementId: second.id, reversedAt: { not: null } } })).toBeGreaterThan(0);
    // corrected result = revision 2 (still needs approval); rejected by the second manager
    const again = await act(s2.id, 'result', { winnerMemberId: t1[2].id, discount: '12000' });
    expect([again.body.data.revision, again.body.data.status]).toEqual([2, 'PENDING_APPROVAL']);
    const rej = await api().post(`${E}/settlements/${again.body.data.id}/reject`).set(bearer(m2Token)).send({ note: 'needs recount' });
    expect(rej.body.data.status).toBe('REJECTED');
    expect((await prisma.auctionSession.findUniqueOrThrow({ where: { id: s2.id } })).status).toBe('CLOSED');
  });

  it('engine payouts: deductions are fixed, rejection refused; disbursal records the event', async () => {
    const st = await prisma.auctionSettlement.findFirstOrThrow({ where: { sessionId: s1.id } });
    const payout = await prisma.payout.findUniqueOrThrow({ where: { auctionId: st.auctionId! } });
    expect((await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(A.managerToken)).send({ status: 'REJECTED' })).body.code).toBe('ENGINE_PAYOUT');
    expect((await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(A.managerToken)).send({ status: 'APPROVED', deductions: 100 })).body.code).toBe('ENGINE_PAYOUT');
    expect((await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(A.managerToken)).send({ status: 'DISBURSED', paymentMode: 'BANK_TRANSFER' })).status).toBe(200);
    const ev = await prisma.financialEvent.findFirstOrThrow({ where: { type: 'PRIZE_DISBURSED', sourceId: payout.id } });
    expect(ev.payload).toMatchObject({ gross: '85000.00', net: '85000.00', deductions: '0.00', mode: 'BANK_TRANSFER' });
    expect((await api().post(`${E}/settlements/${st.id}/reverse`).set(bearer(A.managerToken)).send({ reason: 'x' })).body.code).toBe('PAYOUT_IN_PROGRESS');
  });
});

describe('P6 — eligibility override and P5 prize deductions (G2: two instalments overdue)', () => {
  it('overdue winner is ineligible under the test rule; a manager override with reason allows the result; overdue dues are deducted and settled at disbursal', async () => {
    await activatePolicy(A.managerToken, { scope: 'GROUP', groupId: g2.id, kind: 'ELIGIBILITY', values: { maxOverdueAmount: '0', overridableRules: ['MAX_OVERDUE'] } });
    await activatePolicy(A.managerToken, { scope: 'GROUP', groupId: g2.id, kind: 'SETTLEMENT', values: { prizeDeductions: 'OVERDUE_DUES' } });
    const s = await api().post(`${E}/groups/${g2.id}/sessions`).set(bearer(A.managerToken)).send({ date: today, opensAtLocal: '09:00', closesAtLocal: '10:00' });
    expect(s.status).toBe(201);
    await act(s.body.data.id, 'open');
    const detail = await api().get(`${E}/sessions/${s.body.data.id}`).set(bearer(A.managerToken));
    expect(detail.body.data.eligibility).toHaveLength(6);
    expect(detail.body.data.eligibility.every((e: any) => e.eligible === false)).toBe(true);
    await act(s.body.data.id, 'close');
    const winner = t2[0].id;
    const refused = await act(s.body.data.id, 'result', { winnerMemberId: winner, discount: '6000' });
    expect([refused.status, refused.body.code]).toEqual([422, 'WINNER_NOT_ELIGIBLE']);
    expect((await act(s.body.data.id, 'eligibility/override', { memberId: winner })).status).toBe(400); // reason required
    const ov = await act(s.body.data.id, 'eligibility/override', { memberId: winner, reason: 'Paid in cash at the auction; receipt to follow' });
    expect(ov.status).toBe(201);
    expect(ov.body.data.overriddenRules).toEqual(['MAX_OVERDUE']);
    const r = await act(s.body.data.id, 'result', { winnerMemberId: winner, discount: '6000' });
    expect(r.status).toBe(201);
    // D 6,000; F 3,000; pool 3,000 → ₹500/seat; G 54,000; deductions = 2 × ₹10,000 overdue; net 34,000
    expect(r.body.data).toMatchObject({ commission: '3000.00', dividendPerShare: '500.00', grossPrize: '54000.00', deductions: '20000.00', netPrize: '34000.00' });
    const payout = await prisma.payout.findUniqueOrThrow({ where: { auctionId: r.body.data.auctionId } });
    await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(A.managerToken)).send({ status: 'DISBURSED', paymentMode: 'CASH' });
    const dues = await prisma.memberDue.findMany({ where: { memberId: winner }, orderBy: { periodNo: 'asc' } });
    expect(dues.slice(0, 2).map((d) => d.paidAmount.toFixed(2))).toEqual(['10000.00', '10000.00']);
    const offset = await prisma.paymentTransaction.findFirstOrThrow({ where: { paymentMode: 'PRIZE_OFFSET', subscriberId: t2[0].subscriberId } });
    expect(Number(offset.amount)).toBe(20000);
    // no PAYMENT_RECEIVED for the offset (the receivable is credited by PRIZE_DISBURSED)
    expect(await prisma.financialEvent.count({ where: { type: 'PAYMENT_RECEIVED', sourceId: offset.id } })).toBe(0);
  });
});

describe('P5 — other transitions, cron, isolation, guarantees', () => {
  it('no-bid (test rule CANCEL_SESSION), postpone (keeps the occurrence key) and cancel need reasons', async () => {
    const s = await api().post(`${E}/groups/${g1.id}/sessions`).set(bearer(A.managerToken)).send({ date: addDays(today, 70), opensAtLocal: '09:00', closesAtLocal: '10:00' });
    const pp = await act(s.body.data.id, 'postpone', { date: addDays(today, 71), opensAtLocal: '09:00', closesAtLocal: '10:00' });
    expect(pp.status).toBe(400);
    const p2 = await act(s.body.data.id, 'postpone', { date: addDays(today, 71), opensAtLocal: '09:00', closesAtLocal: '10:00', reason: 'venue unavailable' });
    expect(p2.body.data.scheduledDate).toBe(addDays(today, 71));
    await act(s.body.data.id, 'open');
    const nb = await act(s.body.data.id, 'no-bid');
    expect([nb.body.data.status, nb.body.data.statusReason]).toEqual(['CANCELLED', 'no bid (cancelled per policy)']);
    expect((await act(s.body.data.id, 'open')).body.code).toBe('INVALID_STATE');
  });
  it('cron requires the secret; staff read only; other tenants 404', async () => {
    expect((await api().post(`${E}/scheduler/cron`).send({})).status).toBe(401);
    expect((await api().post(`${E}/scheduler/cron`).set('X-Cron-Secret', 'x'.repeat(40)).send({})).status).toBe(401);
    expect((await api().get(`${E}/sessions/${s1.id}`).set(bearer(B.managerToken))).status).toBe(404);
    expect((await act(s1.id, 'close', {}, B.managerToken)).status).toBe(404);
    expect((await act(s1.id, 'open', {}, A.staffToken)).status).toBe(403);
    expect((await api().get(`${E}/sessions`).set(bearer(B.managerToken))).body.data).toEqual([]);
  });
  it('settlement amounts and calculation runs are immutable; one live settlement per session', async () => {
    const st = await prisma.auctionSettlement.findFirstOrThrow({ where: { status: 'SETTLED' } });
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuctionSettlement" SET "commission" = 0 WHERE id = '${st.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "CalculationRun" SET "outputHash" = 'x'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuctionSettlement" WHERE id = '${st.id}'`)).rejects.toThrow(/append-only/);
    // the legacy endpoint refuses engine groups
    expect((await api().post('/api/v1/auctions/confirm').set(bearer(A.managerToken)).send({ groupId: g1.id, installmentNo: 5, auctionDate: today, winningBidDiscount: 12000, winnerSubscriberId: t1[5].subscriberId })).body.code).toBe('ENGINE_GROUP_USE_SESSIONS');
  });
});
