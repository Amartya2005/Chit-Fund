import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createTenant, createUser, login, prisma, resetDb } from '../helpers.js';
import { E } from '../engine-helpers.js';

/** P9: interest engine — locked by default; FINANCIAL_ENGINE B-4/B-5/B-6/B-7 through the API. Test terms only. */
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let saToken: string;
let account: any;
const I = `${E}/interest`;
const TERMS = {
  method: 'REDUCING_BALANCE',
  annualRatePercent: '12',
  penalRatePercent: '24',
  graceDays: 5,
  lateFee: '200',
  prepayment: { allowed: true, chargePercent: '2', mode: 'REDUCE_EMI' },
  waterfall: ['LATE_FEE', 'PENAL', 'INTEREST', 'PRINCIPAL'],
};
const repay = (amount: string, date: string) => api().post(`${I}/accounts/${account.id}/repayments`).set(bearer(A.managerToken)).send({ amount, date, mode: 'CASH' });
const getAcc = async () => (await api().get(`${I}/accounts/${account.id}`).set(bearer(A.managerToken))).body.data;

beforeAll(async () => {
  await resetDb();
  A = await createTenant('IA');
  B = await createTenant('IB');
  saToken = await login((await createUser('SUPER_ADMIN', null, 'p9sa')).username);
});

describe('P9 — the interest engine is locked until the legal sign-off is recorded', () => {
  it('every endpoint refuses while locked; only the super admin can unlock, with a written attestation', async () => {
    const r = await api().post(`${I}/products`).set(bearer(A.managerToken)).send({ code: 'LOAN12', name: 'x', terms: TERMS });
    expect([r.status, r.body.code]).toEqual([403, 'INTEREST_ENGINE_LOCKED']);
    expect((await api().patch(`${E}/companies/${A.company.id}/interest-engine`).set(bearer(A.managerToken)).send({ enabled: true, attestation: 'x'.repeat(40) })).status).toBe(403);
    expect((await api().patch(`${E}/companies/${A.company.id}/interest-engine`).set(bearer(saToken)).send({ enabled: true, attestation: 'ok' })).body.code).toBe('ATTESTATION_REQUIRED');
    const ok = await api().patch(`${E}/companies/${A.company.id}/interest-engine`).set(bearer(saToken)).send({ enabled: true, attestation: 'TEST ONLY — no real legal sign-off; enabled for automated tests of the engine.' });
    expect(ok.body.data.interestEngineEnabled).toBe(true);
    expect((await api().get(`${I}/products`).set(bearer(B.managerToken))).body.code).toBe('INTEREST_ENGINE_LOCKED');
  });
});

describe('P9 — products and accounts', () => {
  it('terms are validated with no defaults', async () => {
    const { waterfall: _w, ...noWaterfall } = TERMS;
    expect((await api().post(`${I}/products`).set(bearer(A.managerToken)).send({ code: 'BAD', name: 'x', terms: noWaterfall })).status).toBe(422);
    expect((await api().post(`${I}/products`).set(bearer(A.managerToken)).send({ code: 'BAD', name: 'x', terms: { ...TERMS, method: 'FLAT' } })).body.details.issues[0].path).toBe('terms.prepayment');
    expect((await api().post(`${I}/products`).set(bearer(A.managerToken)).send({ code: 'BAD', name: 'x', terms: { ...TERMS, waterfall: ['PENAL', 'PENAL', 'INTEREST', 'PRINCIPAL'] } })).status).toBe(422);
    const p = await api().post(`${I}/products`).set(bearer(A.managerToken)).send({ code: 'LOAN12', name: '12% reducing (test)', terms: TERMS });
    expect([p.status, p.body.data.version]).toEqual([201, 1]);
  });

  it('B-4: disbursement creates the reducing-balance schedule', async () => {
    const c = await api().post(`${I}/accounts`).set(bearer(A.managerToken)).send({ subscriberId: A.subscriber.id, productCode: 'LOAN12', principal: '100000', termMonths: 12, firstDueDate: '2027-02-01' });
    expect([c.status, c.body.data.accountNo, c.body.data.status]).toEqual([201, 'LN-000001', 'DRAFT']);
    account = c.body.data;
    const d = await api().post(`${I}/accounts/${account.id}/disburse`).set(bearer(A.managerToken)).send({ date: '2027-01-01', mode: 'BANK_TRANSFER' });
    expect(d.body.data.status).toBe('ACTIVE');
    expect(d.body.data.installments.map((i: any) => i.interest)).toEqual(['1000.00', '921.15', '841.51', '761.08', '679.84', '597.79', '514.92', '431.22', '346.68', '261.30', '175.07', '87.97']);
    expect(d.body.data.installments.map((i: any) => i.dueDate).slice(0, 3)).toEqual(['2027-02-01', '2027-03-01', '2027-04-01']);
    expect((await api().post(`${I}/accounts/${account.id}/disburse`).set(bearer(A.managerToken)).send({ date: '2027-01-01', mode: 'CASH' })).body.code).toBe('INVALID_STATE');
  });
});

describe('P9 — repayments, prepayment (B-6) and penalties (B-5/B-7)', () => {
  it('six EMIs paid on time', async () => {
    for (let k = 0; k < 6; k++) {
      const r = await repay('8884.88', `2027-0${k + 2}-01`);
      expect(r.status).toBe(201);
    }
    expect((await getAcc()).outstandingPrincipal).toBe('51492.09');
  });

  it('B-6: ₹20,400 with nothing due = ₹20,000 prepayment + 2% charge; remaining 6 instalments re-scheduled (EMI ₹5,433.91)', async () => {
    const r = await repay('20400', '2027-07-15');
    expect(r.status).toBe(201);
    expect(r.body.data.lines).toEqual([
      { installmentNo: null, bucket: 'PREPAYMENT_FEE', amount: '400.00' },
      { installmentNo: null, bucket: 'PREPAYMENT', amount: '20000.00' },
    ]);
    const a = await getAcc();
    expect(a.outstandingPrincipal).toBe('31492.09');
    const live = a.installments.filter((i: any) => !i.superseded && i.scheduleVersion === 2);
    expect(live).toHaveLength(6);
    expect((Number(live[0].principal) + Number(live[0].interest)).toFixed(2)).toBe('5433.91');
    expect(live[0].dueDate).toBe('2027-08-01');
  });

  it('B-5/B-7: penal interest after grace and a late fee; a partial payment follows the waterfall', async () => {
    const run = await api().post(`${I}/accounts/${account.id}/penal-run`).set(bearer(A.managerToken)).send({ asOf: '2027-08-21' });
    // instalment 7 (₹5,433.91) due 08-01, grace ends 08-06 → 15 days → 5,433.91 × 24% × 15/365 = 53.594…
    expect(run.body.data).toEqual([
      { kind: 'LATE_FEE', installmentNo: 7, amount: '200.00' },
      { kind: 'PENAL', installmentNo: 7, amount: '53.59' },
    ]);
    expect((await api().post(`${I}/accounts/${account.id}/penal-run`).set(bearer(A.managerToken)).send({ asOf: '2027-08-21' })).body.data).toEqual([]);
    const r = await repay('1000', '2027-08-21');
    const inst7 = (await getAcc()).installments.find((i: any) => !i.superseded && i.installmentNo === 7);
    expect(r.body.data.lines).toEqual([
      { installmentNo: 7, bucket: 'LATE_FEE', amount: '200.00' },
      { installmentNo: 7, bucket: 'PENAL', amount: '53.59' },
      { installmentNo: 7, bucket: 'INTEREST', amount: inst7.interest },
      { installmentNo: 7, bucket: 'PRINCIPAL', amount: (1000 - 253.59 - Number(inst7.interest)).toFixed(2) },
    ]);
  });

  it('payment above what can be applied is refused without recording anything; accounting events recorded', async () => {
    const before = await prisma.interestRepayment.count();
    const r = await repay('999999', '2027-08-22');
    expect(r.body.code).toBe('PREPAYMENT_AMOUNT');
    expect(await prisma.interestRepayment.count()).toBe(before);
    expect(await prisma.financialEvent.count({ where: { type: 'LOAN_DISBURSED' } })).toBe(1);
    expect(await prisma.financialEvent.count({ where: { type: 'LOAN_REPAYMENT' } })).toBe(before);
    const ev = await prisma.financialEvent.findFirstOrThrow({ where: { type: 'LOAN_REPAYMENT', sourceId: (await prisma.interestRepayment.findFirstOrThrow({ where: { amount: 20400 } })).id } });
    expect(ev.payload).toMatchObject({ principal: '20000.00', fees: '400.00', interest: '0.00' });
  });

  it('isolation and re-locking', async () => {
    expect((await api().get(`${I}/accounts/${account.id}`).set(bearer(B.managerToken))).status).toBe(404);
    expect((await api().get(`${I}/accounts/${account.id}`).set(bearer(A.staffToken))).status).toBe(403);
    expect((await api().patch(`${E}/companies/${A.company.id}/interest-engine`).set(bearer(saToken)).send({ enabled: false })).body.code).toBe('ACCOUNTS_ACTIVE');
    await expect(prisma.$executeRawUnsafe(`UPDATE "InterestRepayment" SET amount = 1`)).rejects.toThrow(/immutable/);
  });
});
