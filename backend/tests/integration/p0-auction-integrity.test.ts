import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, bearer, createTenant, createUser, login, prisma, recordCash, resetDb } from '../helpers.js';

/**
 * P0 regression tests: existing auction workflow integrity & financial correctness.
 * Real PostgreSQL (disposable test database). Expected values are exact (paise).
 */
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;

async function addMember(token: string, groupId: string, name: string, phone: string) {
  const res = await api().post('/api/v1/subscribers').set(bearer(token)).send({ fullName: name, phone, groupId });
  if (res.status !== 201) throw new Error(`addMember failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function createGroup(token: string, body: Record<string, unknown>) {
  const res = await api().post('/api/v1/chit-groups').set(bearer(token)).send(body);
  if (res.status !== 201) throw new Error(`createGroup failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const confirm = (token: string, body: Record<string, unknown>) => api().post('/api/v1/auctions/confirm').set(bearer(token)).send(body);

/** The exact payload the existing manager screen (AuctionsPayoutsTab, before P0) sent. */
const uiPayload = (groupId: string, subscriberId: string, installmentNo: number, discount: number) => ({
  groupId,
  installmentNo,
  auctionDate: '2026-02-01',
  winningBidDiscount: discount,
  winningSubscriberId: subscriberId,
});

let g1: any; // 10 seats, 10 instalments; 4 active tickets
const m: any[] = [];

beforeAll(async () => {
  await resetDb();
  A = await createTenant('PA');
  B = await createTenant('PB');
  g1 = A.group; // ₹1,00,000 · 10 seats · 10 months · staff assigned · 1 member already enrolled
  m.push(A.subscriber);
  m.push(await addMember(A.managerToken, g1.id, 'Member Two', '9100000002'));
  m.push(await addMember(A.managerToken, g1.id, 'Member Three', '9100000003'));
  m.push(await addMember(A.managerToken, g1.id, 'Member Four', '9100000004'));
});

afterAll(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS p0_fail_payout ON "Payout"');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS p0_fail_payout_fn()');
});

describe('1-2. auction confirmation contract (defect E1) and persisted winner', () => {
  it('accepts the payload the manager UI sends (winningSubscriberId) — failed with 400 before P0', async () => {
    const res = await confirm(A.managerToken, uiPayload(g1.id, m[1].id, 1, 15000));
    expect(res.status).toBe(201);

    const ticket = await prisma.chitGroupMember.findFirstOrThrow({ where: { groupId: g1.id, subscriberId: m[1].id } });
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(auction.winnerSubscriberId).toBe(m[1].id);
    expect(auction.winnerMemberId).toBe(ticket.id);
    expect(auction.winningTicketNo).toBe(ticket.ticketNumber);
    expect(auction.calculationVersion).toBe('p0-1');

    // Financials: 5% of 1,00,000 = 5,000; pool 10,000; ÷ 10 seats = 1,000 per ticket; prize 85,000
    expect(auction.foremanCommission).toBe(5000);
    expect(auction.totalDividend).toBe(10000);
    expect(auction.dividendPerMember).toBe(1000);

    const payout = await prisma.payout.findUniqueOrThrow({ where: { auctionId: auction.id } });
    expect(payout.subscriberId).toBe(m[1].id);
    expect(payout.grossBidAmount).toBe(85000);
    expect(payout.netPayoutAmount).toBe(85000);
    expect(payout.status).toBe('PENDING');

    const next = await prisma.installmentSchedule.findFirstOrThrow({ where: { groupId: g1.id, installmentNo: 2 } });
    expect(next.dividendAmount).toBe(1000);
    expect(next.netDueAmount).toBe(9000);
  });

  it('accepts the documented field name winnerSubscriberId too', async () => {
    const res = await confirm(A.managerToken, { groupId: g1.id, installmentNo: 2, auctionDate: '2026-03-01', winningBidDiscount: 12000, winnerSubscriberId: m[2].id });
    expect(res.status).toBe(201);
    expect(res.body.data.winnerSubscriberId).toBe(m[2].id);
  });

  it('rejects conflicting winner fields and a ticket number that is not the winner\'s', async () => {
    const both = await confirm(A.managerToken, { ...uiPayload(g1.id, m[0].id, 3, 10000), winnerSubscriberId: m[3].id });
    expect(both.status).toBe(400);
    expect(both.body.code).toBe('CONFLICTING_WINNER');
    const wrongTicket = await confirm(A.managerToken, { ...uiPayload(g1.id, m[0].id, 3, 10000), winningTicketNo: 4 });
    expect(wrongTicket.status).toBe(400);
    expect(wrongTicket.body.code).toBe('TICKET_MISMATCH');
  });

  it('preview returns exactly the numbers that confirmation persists', async () => {
    const preview = await api().post('/api/v1/auctions/preview').set(bearer(A.managerToken)).send(uiPayload(g1.id, m[0].id, 3, 13000));
    expect(preview.status).toBe(200);
    expect(preview.body.data.valid).toBe(true);
    const calc = preview.body.data.calculation;
    const res = await confirm(A.managerToken, uiPayload(g1.id, m[0].id, 3, 13000));
    expect(res.status).toBe(201);
    expect(res.body.data.foremanCommission).toBe(calc.foremanCommission);
    expect(res.body.data.totalDividend).toBe(calc.dividendPool);
    expect(res.body.data.dividendPerMember).toBe(calc.dividendPerTicket);
    expect(res.body.data.payout.grossBidAmount).toBe(calc.grossPrize);
    expect(calc.foremanCommission).toBe(5000);
    expect(calc.dividendPool).toBe(8000);
    expect(calc.dividendPerTicket).toBe(800);
    expect(calc.grossPrize).toBe(87000);
  });
});

describe('5. commission cannot exceed the winning discount (defect E6)', () => {
  it('refuses settlement, writes nothing and keeps the calculation for audit', async () => {
    const before = await prisma.auction.count({ where: { groupId: g1.id } });
    const res = await confirm(A.managerToken, uiPayload(g1.id, m[3].id, 4, 4999.99));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COMMISSION_EXCEEDS_DISCOUNT');
    expect(res.body.details.calculation.commissionShortfall).toBe(0.01);
    expect(res.body.details.calculation.dividendPool).toBe(0);
    expect(await prisma.auction.count({ where: { groupId: g1.id } })).toBe(before);
    expect(await prisma.payout.count({ where: { auction: { groupId: g1.id, installmentNo: 4 } } })).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'AUCTION_CONFIRMATION_REJECTED', entityId: g1.id } });
    expect(JSON.parse(audit.details!).calculation.errors[0].code).toBe('COMMISSION_EXCEEDS_DISCOUNT');
  });

  it('discount equal to the commission is accepted with a zero dividend', async () => {
    const res = await confirm(A.managerToken, uiPayload(g1.id, m[3].id, 4, 5000));
    expect(res.status).toBe(201);
    expect(res.body.data.totalDividend).toBe(0);
    expect(res.body.data.dividendAllocations).toEqual([]);
  });
});

describe('6-8. every rupee of the dividend pool is accounted for', () => {
  it('unfilled seats: 4 active tickets of 10 → 6 seats\' share preserved as PENDING_DECISION', async () => {
    const auction = await prisma.auction.findFirstOrThrow({ where: { groupId: g1.id, installmentNo: 1 } });
    const rows = await prisma.auctionDividendAllocation.findMany({ where: { auctionId: auction.id } });
    const credits = rows.filter((r) => r.kind === 'TICKET_CREDIT');
    expect(credits).toHaveLength(4);
    expect(credits.every((r) => r.amount === 1000 && r.status === 'CREDITED_TO_INSTALLMENT' && r.targetInstallmentNo === 2)).toBe(true);
    const vacant = rows.find((r) => r.kind === 'VACANT_SEATS')!;
    expect(vacant.amount).toBe(6000);
    expect(vacant.status).toBe('PENDING_DECISION');
    expect(rows.reduce((s, r) => s + Math.round(r.amount * 100), 0)).toBe(1000000);
  });

  it('rounding remainder is preserved (₹1,00,000 · 3 seats · discount ₹6,000 → ₹333.33 each + ₹0.01)', async () => {
    const g = await createGroup(A.managerToken, { name: 'Three seats', chitValue: 100000, maxMembers: 3, totalMonths: 3, startDate: '2026-01-10' });
    const a = await addMember(A.managerToken, g.id, 'R1', '9200000001');
    await addMember(A.managerToken, g.id, 'R2', '9200000002');
    await addMember(A.managerToken, g.id, 'R3', '9200000003');
    const res = await confirm(A.managerToken, uiPayload(g.id, a.id, 1, 6000));
    expect(res.status).toBe(201);
    expect(res.body.data.dividendPerMember).toBe(333.33);
    const rows = res.body.data.dividendAllocations;
    expect(rows.find((r: any) => r.kind === 'ROUNDING_REMAINDER').amount).toBe(0.01);
    expect(rows.filter((r: any) => r.kind === 'TICKET_CREDIT')).toHaveLength(3);
    expect(res.body.data.creditedTotal).toBe(999.99);
    expect(res.body.data.pendingDecisionTotal).toBe(0.01);
  });

  it('final auction: no next instalment exists → the whole pool is preserved, no schedule is touched', async () => {
    const g = await createGroup(A.managerToken, { name: 'Two months', chitValue: 20000, maxMembers: 2, totalMonths: 2, startDate: '2026-01-15' });
    const a = await addMember(A.managerToken, g.id, 'F1', '9300000001');
    const b = await addMember(A.managerToken, g.id, 'F2', '9300000002');
    expect((await confirm(A.managerToken, uiPayload(g.id, a.id, 1, 2000))).status).toBe(201);
    const before = await prisma.installmentSchedule.findMany({ where: { groupId: g.id }, orderBy: { installmentNo: 'asc' } });
    const res = await confirm(A.managerToken, uiPayload(g.id, b.id, 2, 3000));
    expect(res.status).toBe(201);
    // commission 1,000; pool 2,000 → NO_NEXT_INSTALLMENT, pending decision
    expect(res.body.data.dividendAllocations).toEqual([
      expect.objectContaining({ kind: 'NO_NEXT_INSTALLMENT', amount: 2000, status: 'PENDING_DECISION' }),
    ]);
    const after = await prisma.installmentSchedule.findMany({ where: { groupId: g.id }, orderBy: { installmentNo: 'asc' } });
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
    const pending = await api().get('/api/v1/auctions/dividend-allocations/pending').set(bearer(A.managerToken));
    expect(pending.status).toBe(200);
    expect(pending.body.data.some((r: any) => r.auctionId === res.body.data.id && r.amount === 2000)).toBe(true);
  });
});

describe('3-4. eligibility derived from the database (defect E2)', () => {
  it('reports ticket status, prized flags and reasons; repeat wins are explicitly permitted (pending D-04)', async () => {
    const res = await api().get(`/api/v1/auctions/group/${g1.id}/eligibility`).set(bearer(A.managerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.repeatWinPolicy).toBe('PERMITTED_PENDING_DECISION_D04');
    expect(res.body.data.nextInstallmentNo).toBe(5);
    expect(res.body.data.activeTickets).toBe(4);
    const t2 = res.body.data.tickets.find((t: any) => t.subscriberId === m[1].id);
    expect(t2).toMatchObject({ membershipStatus: 'ACTIVE', isPrized: true, prizedCount: 1, prizedInstallmentNo: 1, eligible: true });
    expect(t2.reasons.map((r: any) => r.code)).toContain('ALREADY_PRIZED');
    expect(t2.reasons.find((r: any) => r.code === 'ALREADY_PRIZED').blocking).toBe(false);

    const details = await api().get(`/api/v1/chit-groups/${g1.id}`).set(bearer(A.managerToken));
    expect(details.body.data.currentInstallmentNo).toBe(5);
    const member2 = details.body.data.members.find((x: any) => x.subscriberId === m[1].id);
    expect(member2).toMatchObject({ isPrized: true, prizedInstallmentNo: 1, membershipStatus: 'ACTIVE' });
  });

  it('existing behaviour preserved: a prized ticket can still be selected (no new one-win rule)', async () => {
    const res = await confirm(A.managerToken, uiPayload(g1.id, m[1].id, 5, 9000));
    expect(res.status).toBe(201);
  });

  it('rejects a winner who is not a member of the group', async () => {
    const outsider = await api().post('/api/v1/subscribers').set(bearer(A.managerToken)).send({ fullName: 'Outsider', phone: '9100000099' });
    const res = await confirm(A.managerToken, uiPayload(g1.id, outsider.body.data.id, 6, 9000));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WINNER_NOT_A_MEMBER');
  });

  it('rejects an inactive (suspended) subscriber with an explanation', async () => {
    const s = await addMember(A.managerToken, g1.id, 'Suspended Five', '9100000005');
    await prisma.subscriber.update({ where: { id: s.id }, data: { status: 'SUSPENDED' } });
    const res = await confirm(A.managerToken, uiPayload(g1.id, s.id, 6, 9000));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WINNER_NOT_ELIGIBLE');
    expect(res.body.details.ticket.reasons.map((r: any) => r.code)).toContain('SUBSCRIBER_INACTIVE');
    await prisma.subscriber.update({ where: { id: s.id }, data: { status: 'ACTIVE' } });
    m.push(s);
  });
});

describe('10-11. surrendered tickets keep their history and cannot participate (defect E11)', () => {
  let surrenderer: any;
  it('surrender keeps the ticket row with status SURRENDERED, payments and history intact', async () => {
    surrenderer = await addMember(A.managerToken, g1.id, 'Leaver Six', '9100000006');
    expect((await recordCash(A.managerToken, surrenderer.id, g1.id, 9000, 2)).status).toBe(201);
    const refund = await api().post('/api/v1/refunds').set(bearer(A.managerToken)).send({ subscriberId: surrenderer.id, groupId: g1.id, amount: 1000, reason: 'Moving away' });
    expect(refund.status).toBe(201);
    expect((await api().patch(`/api/v1/refunds/${refund.body.data.id}/process`).set(bearer(A.managerToken)).send({ status: 'APPROVED' })).status).toBe(200);

    const ticket = await prisma.chitGroupMember.findFirstOrThrow({ where: { groupId: g1.id, subscriberId: surrenderer.id } });
    expect(ticket.status).toBe('SURRENDERED');
    expect(ticket.exitedAt).not.toBeNull();
    expect(ticket.exitRefundId).toBe(refund.body.data.id);
    expect(await prisma.paymentTransaction.count({ where: { subscriberId: surrenderer.id } })).toBe(1);

    const sub = await api().get(`/api/v1/subscribers/${surrenderer.id}`).set(bearer(A.managerToken));
    expect(sub.body.data.memberships.find((x: any) => x.groupId === g1.id).status).toBe('SURRENDERED');
    const ledger = await api().get(`/api/v1/subscribers/${surrenderer.id}/ledger`).set(bearer(A.managerToken));
    const gl = ledger.body.data.groups.find((x: any) => x.groupId === g1.id);
    expect(gl.membershipStatus).toBe('SURRENDERED');
    expect(gl.countsTowardSummary).toBe(false);
    expect(gl.totalPaidInGroup).toBe(9000);
    const details = await api().get(`/api/v1/chit-groups/${g1.id}`).set(bearer(A.managerToken));
    expect(details.body.data.members.find((x: any) => x.subscriberId === surrenderer.id).membershipStatus).toBe('SURRENDERED');
    const list = await api().get('/api/v1/subscribers').set(bearer(A.managerToken));
    const listed = list.body.data.find((x: any) => x.id === surrenderer.id);
    expect(listed.memberships).toHaveLength(0);
    expect(listed.exitedMemberships).toHaveLength(1);
  });

  it('a surrendered ticket is ineligible and cannot be selected as winner', async () => {
    const elig = await api().get(`/api/v1/auctions/group/${g1.id}/eligibility`).set(bearer(A.managerToken));
    const t = elig.body.data.tickets.find((x: any) => x.subscriberId === surrenderer.id);
    expect(t.eligible).toBe(false);
    expect(t.reasons[0].code).toBe('MEMBERSHIP_SURRENDERED');
    const res = await confirm(A.managerToken, uiPayload(g1.id, surrenderer.id, 6, 9000));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WINNER_NOT_ELIGIBLE');
  });

  it('surrendered seat does not count as an active ticket for dividends', async () => {
    const res = await confirm(A.managerToken, uiPayload(g1.id, m[0].id, 6, 15000));
    expect(res.status).toBe(201);
    const credits = res.body.data.dividendAllocations.filter((r: any) => r.kind === 'TICKET_CREDIT');
    expect(credits.some((r: any) => r.subscriberId === surrenderer.id)).toBe(false);
    expect(credits).toHaveLength(5); // m[0..3] + Suspended Five (re-activated)
    expect(res.body.data.dividendAllocations.find((r: any) => r.kind === 'VACANT_SEATS').amount).toBe(5000);
  });
});

describe('12-14. duplicates, concurrency and rollback', () => {
  it('a second confirmation of the same instalment is rejected and creates no payout', async () => {
    const res = await confirm(A.managerToken, uiPayload(g1.id, m[2].id, 6, 15000));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUCTION_ALREADY_RECORDED');
    expect(await prisma.payout.count({ where: { auction: { groupId: g1.id, installmentNo: 6 } } })).toBe(1);
  });

  it('concurrent confirmations of one instalment settle exactly once', async () => {
    const winners = [m[0], m[1], m[2], m[3], m[0], m[1], m[2], m[3]];
    const results = await Promise.all(winners.map((w) => confirm(A.managerToken, uiPayload(g1.id, w.id, 7, 10000))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(await prisma.auction.count({ where: { groupId: g1.id, installmentNo: 7 } })).toBe(1);
    expect(await prisma.payout.count({ where: { auction: { groupId: g1.id, installmentNo: 7 } } })).toBe(1);
    const auction = await prisma.auction.findFirstOrThrow({ where: { groupId: g1.id, installmentNo: 7 } });
    const alloc = await prisma.auctionDividendAllocation.findMany({ where: { auction: { groupId: g1.id, installmentNo: 7 } } });
    expect(alloc.every((a) => a.auctionId === auction.id)).toBe(true);
    expect(alloc.reduce((s, r) => s + Math.round(r.amount * 100), 0)).toBe(Math.round(auction.totalDividend * 100));
  });

  it('a failure in the middle of settlement rolls everything back', async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION p0_fail_payout_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected payout failure'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER p0_fail_payout BEFORE INSERT ON "Payout" FOR EACH ROW EXECUTE FUNCTION p0_fail_payout_fn()`);
    const nextBefore = await prisma.installmentSchedule.findFirstOrThrow({ where: { groupId: g1.id, installmentNo: 9 } });
    const auditsBefore = await prisma.auditLog.count({ where: { action: 'CONFIRM_AUCTION_RESULT' } });
    try {
      const res = await confirm(A.managerToken, uiPayload(g1.id, m[3].id, 8, 20000));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('injected');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS p0_fail_payout ON "Payout"');
    }
    expect(await prisma.auction.count({ where: { groupId: g1.id, installmentNo: 8 } })).toBe(0);
    expect(await prisma.auctionDividendAllocation.count({ where: { auction: { groupId: g1.id, installmentNo: 8 } } })).toBe(0);
    const nextAfter = await prisma.installmentSchedule.findFirstOrThrow({ where: { groupId: g1.id, installmentNo: 9 } });
    expect(JSON.parse(JSON.stringify(nextAfter))).toEqual(JSON.parse(JSON.stringify(nextBefore)));
    expect(await prisma.auditLog.count({ where: { action: 'CONFIRM_AUCTION_RESULT' } })).toBe(auditsBefore);
    // and the same instalment can be settled once the fault is gone
    expect((await confirm(A.managerToken, uiPayload(g1.id, m[3].id, 8, 20000))).status).toBe(201);
  });
});

describe('9. arrears count only instalments whose due date has passed (defect E7)', () => {
  let g: any;
  let payer: any;
  let skipper: any;
  beforeAll(async () => {
    // due dates: #1 2026-01-05, #2 2026-02-05, #3 2026-03-05, #4 2026-04-05 …; ₹10,000 each
    g = await createGroup(A.managerToken, { name: 'Arrears group', chitValue: 60000, maxMembers: 6, totalMonths: 6, startDate: '2026-01-05' });
    payer = await addMember(A.managerToken, g.id, 'Partial Payer', '9400000001');
    skipper = await addMember(A.managerToken, g.id, 'Never Paid', '9400000002');
    expect((await recordCash(A.managerToken, payer.id, g.id, 10000, 1)).status).toBe(201);
    expect((await recordCash(A.managerToken, payer.id, g.id, 4000, 2)).status).toBe(201);
  });

  it('future, due-today, overdue, partially paid and fully paid instalments (as of 2026-03-05)', async () => {
    const res = await api().get(`/api/v1/subscribers/${payer.id}/ledger?asOf=2026-03-05`).set(bearer(A.managerToken));
    expect(res.status).toBe(200);
    const rows = res.body.data.groups.find((x: any) => x.groupId === g.id).schedules;
    expect(rows[0]).toMatchObject({ installmentNo: 1, status: 'PAID', timing: 'PAST', isOverdue: false, outstanding: 0 });
    expect(rows[1]).toMatchObject({ installmentNo: 2, status: 'PARTIAL', timing: 'PAST', isOverdue: true, paidAmount: 4000, outstanding: 6000 });
    expect(rows[2]).toMatchObject({ installmentNo: 3, status: 'DUE', timing: 'TODAY', isOverdue: false, outstanding: 10000 });
    expect(rows[3]).toMatchObject({ installmentNo: 4, status: 'UPCOMING', timing: 'FUTURE', isOverdue: false });
    expect(res.body.data.summary).toMatchObject({ totalArrears: 6000, dueToday: 10000, overdueInstallments: 1, totalPaid: 14000, dueThroughAsOf: 30000 });
  });

  it('multiple missed instalments', async () => {
    const res = await api().get(`/api/v1/subscribers/${skipper.id}/ledger?asOf=2026-03-06`).set(bearer(A.managerToken));
    expect(res.body.data.summary).toMatchObject({ totalArrears: 30000, overdueInstallments: 3, dueToday: 0 });
  });

  it('nothing is in arrears before the first due date', async () => {
    const res = await api().get(`/api/v1/subscribers/${skipper.id}/ledger?asOf=2026-01-04`).set(bearer(A.managerToken));
    expect(res.body.data.summary.totalArrears).toBe(0);
    expect(res.body.data.summary.upcoming).toBe(60000);
  });

  it('outstanding report uses the same rule', async () => {
    const res = await api().get('/api/v1/subscribers/outstanding?asOf=2026-03-05').set(bearer(A.managerToken));
    expect(res.status).toBe(200);
    const p = res.body.data.find((x: any) => x.id === payer.id);
    const s = res.body.data.find((x: any) => x.id === skipper.id);
    expect(p).toMatchObject({ arrears: 6000, dueToday: 10000, totalPaid: 14000 });
    expect(s).toMatchObject({ arrears: 20000, overdueInstallments: 2 });
    const bad = await api().get('/api/v1/subscribers/outstanding?asOf=05-03-2026').set(bearer(A.managerToken));
    expect(bad.status).toBe(400);
  });
});

describe('15. tenant isolation and authorization of the auction workflow', () => {
  it('company B cannot confirm, preview or read company A auctions/eligibility', async () => {
    const t = bearer(B.managerToken);
    expect((await confirm(B.managerToken, uiPayload(g1.id, m[0].id, 9, 10000))).status).toBe(404);
    expect((await api().post('/api/v1/auctions/preview').set(t).send(uiPayload(g1.id, m[0].id, 9, 10000))).status).toBe(404);
    expect((await api().get(`/api/v1/auctions/group/${g1.id}/eligibility`).set(t)).status).toBe(404);
    expect((await api().get(`/api/v1/auctions/group/${g1.id}`).set(t)).status).toBe(404);
    expect((await api().get(`/api/v1/chit-groups/${g1.id}`).set(t)).status).toBe(404);
  });

  it('company A subscriber / ticket IDs cannot be used as winners in company B\'s group', async () => {
    const res = await confirm(B.managerToken, uiPayload(B.group.id, m[0].id, 1, 10000));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WINNER_NOT_A_MEMBER');
    const aTicket = await prisma.chitGroupMember.findFirstOrThrow({ where: { groupId: g1.id, subscriberId: m[0].id } });
    const res2 = await confirm(B.managerToken, { groupId: B.group.id, installmentNo: 1, auctionDate: '2026-02-01', winningBidDiscount: 10000, winnerMemberId: aTicket.id });
    expect(res2.status).toBe(400);
    expect(res2.body.code).toBe('WINNER_NOT_A_MEMBER');
    expect(await prisma.auction.count({ where: { groupId: B.group.id } })).toBe(0);
  });

  it('company B cannot see or change company A payouts and pending dividend amounts', async () => {
    const payout = await prisma.payout.findFirstOrThrow({ where: { auction: { groupId: g1.id } } });
    expect((await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(B.managerToken)).send({ status: 'DISBURSED' })).status).toBe(404);
    const list = await api().get('/api/v1/payouts').set(bearer(B.managerToken));
    expect(JSON.stringify(list.body.data)).not.toContain(payout.id);
    const pending = await api().get('/api/v1/auctions/dividend-allocations/pending').set(bearer(B.managerToken));
    expect(pending.body.count).toBe(0);
    const subs = await api().get('/api/v1/subscribers').set(bearer(B.managerToken));
    expect(JSON.stringify(subs.body.data)).not.toContain(m[0].id);
  });

  it('collection staff cannot confirm or preview auctions; settled results cannot be edited via the API', async () => {
    expect((await confirm(A.staffToken, uiPayload(g1.id, m[0].id, 9, 10000))).status).toBe(403);
    expect((await api().post('/api/v1/auctions/preview').set(bearer(A.staffToken)).send(uiPayload(g1.id, m[0].id, 9, 10000))).status).toBe(403);
    const auction = await prisma.auction.findFirstOrThrow({ where: { groupId: g1.id, installmentNo: 1 } });
    for (const method of ['put', 'patch', 'delete'] as const) {
      const r = await (api() as any)[method](`/api/v1/auctions/${auction.id}`).set(bearer(A.managerToken)).send({ winningBidDiscount: 1 });
      expect(r.status).toBe(404);
    }
    const after = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(after.winningBidDiscount).toBe(15000);
  });

  it('a staff member of another group in the same company cannot read eligibility', async () => {
    const other = await createUser('COLLECTION_STAFF', A.company.id, 'p0_other');
    const token = await login(other.username);
    expect((await api().get(`/api/v1/auctions/group/${g1.id}/eligibility`).set(bearer(token))).status).toBe(403);
  });
});

describe('reports no longer present sample figures as live data (defect E8)', () => {
  it('cashbook, bankbook, statements and reports mark unavailable figures', async () => {
    const t = bearer(A.managerToken);
    const cash = await api().get('/api/v1/accounting/cashbook?period=MONTH').set(t);
    expect(cash.body.data.summary.openingBalance).toBeNull();
    expect(cash.body.data.summary.closingBalance).toBeNull();
    expect(cash.body.data.dataQuality.status).toBe('PARTIAL');
    const bank = await api().get('/api/v1/accounting/bankbook').set(t);
    expect(bank.body.data.bankAccounts).toEqual([]);
    expect(bank.body.data.openingBalance).toBeNull();
    const fs = await api().get('/api/v1/accounting/financial-statements').set(t);
    expect(fs.body.data.balanceSheet).toBeNull();
    expect(JSON.stringify(fs.body)).not.toMatch(/74500|385000|142000|95000|12500/);
    const rep = await api().get('/api/v1/accounting/reports').set(t);
    expect(rep.body.data.financialStatementsReport.totalAssets).toBeNull();
    expect(rep.body.data.membersArrearsReport.computedLateFees).toBeNull();
    expect(typeof rep.body.data.membersArrearsReport.totalArrears).toBe('number');
  });
});
