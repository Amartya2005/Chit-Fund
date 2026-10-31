import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createTenant, createUser, login, prisma, recordCash, resetDb } from '../helpers.js';
import { E, addMember, configureCompany, convertGroup, createGroup, enableEngine } from '../engine-helpers.js';

/** P4: events → balanced journal entries after cut-over and mapping; reversals; period locks. */
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let saToken: string;
let manager2Token: string;
let g: any;
const subs: any[] = [];
const acct = (path: string) => `${E}/accounting${path}`;
const events = async (where: Record<string, unknown> = {}) => prisma.financialEvent.findMany({ where: { companyId: A.company.id, ...where }, include: { journalEntry: { include: { lines: { include: { account: true } } } } }, orderBy: { createdAt: 'asc' } });
const run = (asOf: string) => api().post(acct('/run')).set(bearer(A.managerToken)).send({ asOf });

beforeAll(async () => {
  await resetDb();
  A = await createTenant('AA');
  B = await createTenant('AB');
  saToken = await login((await createUser('SUPER_ADMIN', null, 'p4sa')).username);
  manager2Token = await login((await createUser('MANAGER', A.company.id, 'AA_m2')).username);
  await configureCompany(A.managerToken, saToken, A.company.id);
  await enableEngine(saToken, A.company.id);
  g = await createGroup(A.managerToken, { name: 'Ledger group', chitValue: 30000, maxMembers: 3, totalMonths: 3, startDate: '2027-01-05' });
  for (const [i, n] of ['L One', 'L Two', 'L Three'].entries()) subs.push(await addMember(A.managerToken, g.id, n, `90000004${i}0`));
  await convertGroup(A.managerToken, g.id);
  await api().get('/api/v1/accounting/accounts').set(bearer(A.managerToken)); // standard chart
});

describe('P4 — nothing posts without a cut-over date and a complete mapping', () => {
  it('events are recorded but NOT_POSTED with the reason', async () => {
    expect((await recordCash(A.managerToken, subs[0].id, g.id, 10000, 1)).status).toBe(201);
    let ev = await events({ type: 'PAYMENT_RECEIVED' });
    expect(ev.map((e) => [e.postingStatus, e.notPostedReason])).toEqual([['NOT_POSTED', 'NO_LEDGER_CUTOVER']]);
    expect((await api().put(acct('/cutover')).set(bearer(A.managerToken)).send({ date: '2026-01-01' })).status).toBe(200);
    expect((await run('2027-01-10')).status).toBe(200);
    ev = await events({ type: { in: ['PAYMENT_RECEIVED', 'DUE_RAISED'] } });
    expect(ev.every((e) => e.postingStatus === 'NOT_POSTED' && e.notPostedReason!.startsWith('MAPPING_MISSING'))).toBe(true);
    expect(await prisma.journalEntry.count({ where: { companyId: A.company.id } })).toBe(0);
  });

  it('mapping: suggestions are shown, never applied; accounts must belong to the company', async () => {
    const s = await api().get(acct('/settings')).set(bearer(A.managerToken));
    expect(s.body.data.roles.find((r: any) => r.role === 'CASH')).toMatchObject({ account: null, suggestion: { code: '1001' } });
    expect(s.body.data.roles.find((r: any) => r.role === 'CHIT_POOL_PAYABLE').suggestion).toBeNull();
    const bAcc = (await api().get('/api/v1/accounting/accounts').set(bearer(B.managerToken))).body.data[0];
    expect((await api().put(acct('/mappings')).set(bearer(A.managerToken)).send({ mappings: { CASH: bAcc.id } })).status).toBe(404);
    expect((await api().put(acct('/mappings')).set(bearer(A.managerToken)).send({ mappings: { NOT_A_ROLE: bAcc.id } })).status).toBe(400);
  });

  it('after mapping every role, the run posts balanced entries; reruns are idempotent', async () => {
    for (const [code, name] of [['2003', 'Chit Group Pool'], ['2004', 'Dividend Payable'], ['2005', 'Dividend Unallocated (pending decision)']]) {
      expect((await api().post('/api/v1/accounting/accounts').set(bearer(A.managerToken)).send({ code, name, type: 'LIABILITY' })).status).toBe(201);
    }
    const accounts = (await api().get('/api/v1/accounting/accounts').set(bearer(A.managerToken))).body.data as any[];
    const id = (code: string) => accounts.find((a) => a.code === code).id;
    const mappings = { CASH: id('1001'), BANK: id('1002'), SUBSCRIBER_RECEIVABLE: id('1100'), SUBSCRIBER_ADVANCE: id('2002'), PRIZE_PAYABLE: id('2001'), COMMISSION_INCOME: id('4001'), PENALTY_INCOME: id('4002'), CHIT_POOL_PAYABLE: id('2003'), DIVIDEND_PAYABLE: id('2004'), DIVIDEND_UNALLOCATED: id('2005') };
    expect((await api().put(acct('/mappings')).set(bearer(A.managerToken)).send({ mappings })).status).toBe(200);
    const r = await run('2027-01-10');
    expect(r.body.data.results).toEqual({ POSTED: 2 });
    const due = (await events({ type: 'DUE_RAISED' }))[0];
    expect(due.journalEntry!.lines.map((l) => `${l.type} ${l.account.code} ${l.amount.toFixed(2)}`).sort()).toEqual(['CREDIT 2003 30000.00', 'DEBIT 1100 30000.00']);
    const pay = (await events({ type: 'PAYMENT_RECEIVED' }))[0];
    expect(pay.journalEntry!.lines.map((l) => `${l.type} ${l.account.code} ${l.amount.toFixed(2)}`).sort()).toEqual(['CREDIT 1100 10000.00', 'DEBIT 1001 10000.00']);
    expect((await run('2027-01-10')).body.data).toMatchObject({ duePeriodsRaised: 0, attempted: 0 });
    expect(await prisma.journalEntry.count({ where: { companyId: A.company.id } })).toBe(2);
  });

  it('the cut-over date is fixed once something was posted', async () => {
    const r = await api().put(acct('/cutover')).set(bearer(A.managerToken)).send({ date: '2026-06-01' });
    expect([r.status, r.body.code]).toEqual([409, 'CUTOVER_LOCKED']);
  });
});

describe('P4 — postings follow the domain in the same transaction', () => {
  it('overpayment: receivable for the due, advance for the rest; reversal mirrors the entry exactly', async () => {
    const p = await recordCash(A.managerToken, subs[1].id, g.id, 12000, 1);
    const ev = (await events({ type: 'PAYMENT_RECEIVED', sourceId: p.body.data.id }))[0];
    expect(ev.postingStatus).toBe('POSTED');
    expect(ev.journalEntry!.lines.map((l) => `${l.type} ${l.account.code} ${l.amount.toFixed(2)}`).sort()).toEqual(['CREDIT 1100 10000.00', 'CREDIT 2002 2000.00', 'DEBIT 1001 12000.00']);
    expect((await api().post(`/api/v1/collections/${p.body.data.id}/reverse`).set(bearer(A.managerToken)).send({ reason: 'duplicate' })).status).toBe(200);
    const rev = (await events({ type: 'PAYMENT_REVERSED', sourceId: p.body.data.id }))[0];
    expect(rev.postingStatus).toBe('POSTED');
    expect(rev.reversalOfEventId).toBe(ev.id);
    expect(rev.journalEntry!.reversalOfId).toBe(ev.journalEntry!.id);
    const net = new Map<string, number>();
    for (const l of [...ev.journalEntry!.lines, ...rev.journalEntry!.lines]) net.set(l.accountId, (net.get(l.accountId) ?? 0) + (l.type === 'DEBIT' ? 1 : -1) * Math.round(Number(l.amount) * 100));
    expect([...net.values()].every((v) => v === 0)).toBe(true);
  });

  it('a contribution waiver is recorded but not posted until its accounting treatment is decided', async () => {
    const due = await prisma.memberDue.findFirstOrThrow({ where: { groupId: g.id, subscriberId: subs[2].id, periodNo: 2 } });
    const req = await api().post(`${E}/adjustments`).set(bearer(A.managerToken)).send({ type: 'DUE_WAIVER', dueId: due.id, amount: '500', reason: 'hardship' });
    await api().post(`${E}/adjustments/${req.body.data.id}/approve`).set(bearer(manager2Token)).send({});
    const ev = (await events({ type: 'DUE_WAIVED' }))[0];
    expect([ev.postingStatus, ev.amount.toFixed(2)]).toEqual(['NOT_POSTED', '500.00']);
    expect(ev.notPostedReason).toMatch(/^RULE_NEEDS_DECISION/);
  });

  it('ledger trial balance is balanced and exact; every posted entry balances; one entry per event', async () => {
    const tb = await api().get(acct('/trial-balance?asOf=2099-12-31')).set(bearer(A.managerToken));
    expect(tb.body.data.isBalanced).toBe(true);
    expect(tb.body.data.source).toBe('LEDGER');
    const auto = await prisma.journalEntry.findMany({ where: { companyId: A.company.id, sourceEventId: { not: null } }, include: { lines: true } });
    for (const j of auto) {
      const s = j.lines.reduce((acc, l) => acc + (l.type === 'DEBIT' ? 1 : -1) * Math.round(Number(l.amount) * 100), 0);
      expect(s, j.entryNo).toBe(0);
    }
    const posted = await prisma.financialEvent.count({ where: { companyId: A.company.id, postingStatus: 'POSTED' } });
    expect(auto.length).toBe(posted);
  });
});

describe('P4 — accounting periods lock postings (manual and automatic)', () => {
  it('a closed period refuses manual entries and leaves new events in it unposted', async () => {
    const p = await api().post(acct('/periods')).set(bearer(A.managerToken)).send({ name: 'Mar 2027', startDate: '2027-03-01', endDate: '2027-03-31' });
    expect(p.status).toBe(201);
    expect((await api().post(acct('/periods')).set(bearer(A.managerToken)).send({ name: 'overlap', startDate: '2027-03-15', endDate: '2027-04-15' })).body.code).toBe('PERIOD_OVERLAP');
    expect((await api().post(acct(`/periods/${p.body.data.id}/close`)).set(bearer(A.managerToken)).send({})).status).toBe(200);
    const accounts = (await api().get('/api/v1/accounting/accounts').set(bearer(A.managerToken))).body.data as any[];
    const manual = await api().post('/api/v1/accounting/journal-entries').set(bearer(A.managerToken)).send({
      date: '2027-03-10', narration: 'test', lines: [{ accountId: accounts[0].id, type: 'DEBIT', amount: 10 }, { accountId: accounts[1].id, type: 'CREDIT', amount: 10 }],
    });
    expect([manual.status, manual.body.code]).toEqual([409, 'PERIOD_CLOSED']);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "JournalEntry"(id,"companyId","entryNo",date,narration) VALUES (gen_random_uuid()::text,'${A.company.id}','X-1','2027-03-02','raw')`)).rejects.toThrow(/closed/);
    await run('2027-03-10');
    const due3 = (await events({ type: 'DUE_RAISED' })).find((e) => e.occurredOn === '2027-03-05')!;
    expect([due3.postingStatus, due3.notPostedReason]).toEqual(['NOT_POSTED', 'PERIOD_CLOSED:Mar 2027']);
    await expect(prisma.$executeRawUnsafe(`UPDATE "FinancialPeriod" SET status = 'OPEN', "closedById" = NULL, "closedAt" = NULL WHERE id = '${p.body.data.id}'`)).rejects.toThrow(/closed period/);
  });
  it('a period with unposted events (here: the undecided waiver) cannot be closed', async () => {
    const waiver = (await events({ type: 'DUE_WAIVED' }))[0];
    const day = waiver.occurredOn;
    const p = await api().post(acct('/periods')).set(bearer(A.managerToken)).send({ name: 'Waiver month', startDate: day, endDate: day });
    const r = await api().post(acct(`/periods/${p.body.data.id}/close`)).set(bearer(A.managerToken)).send({});
    expect([r.status, r.body.code]).toEqual([409, 'UNPOSTED_EVENTS']);
  });
});

describe('P4 — guarantees and isolation', () => {
  it('events are immutable facts; tenants see only their own ledger data', async () => {
    const ev = (await events({ postingStatus: 'POSTED' }))[0];
    await expect(prisma.$executeRawUnsafe(`UPDATE "FinancialEvent" SET amount = 1 WHERE id = '${ev.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "FinancialEvent" WHERE id = '${ev.id}'`)).rejects.toThrow(/append-only/);
    expect((await api().get(acct('/events')).set(bearer(B.managerToken))).body.data).toEqual([]);
    expect((await api().get(acct('/events')).set(bearer(A.staffToken))).status).toBe(403);
    const per = await prisma.financialPeriod.findFirstOrThrow({ where: { companyId: A.company.id } });
    expect((await api().post(acct(`/periods/${per.id}/close`)).set(bearer(B.managerToken)).send({})).status).toBe(404);
  });
});
