import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createUser, login, prisma, recordCash, resetDb, PASSWORD } from '../helpers.js';

/**
 * End-to-end verification of the existing ChitKart workflows through the HTTP API,
 * with financial assertions. Runs against the disposable test database.
 */
let superToken: string;
let companyId: string;
let managerToken: string;
let staffId: string;
let staffToken: string;
let groupId: string;
const members: { id: string; name: string }[] = [];

beforeAll(async () => {
  await resetDb();
  const sa = await createUser('SUPER_ADMIN', null, 'wf_sa');
  superToken = await login(sa.username);
});

describe('1-2. company creation and manager authentication', () => {
  it('super admin creates a company with its initial manager', async () => {
    const res = await api().post('/api/v1/super-admin/companies').set(bearer(superToken)).send({
      code: 'wfco', name: 'Workflow Chits Pvt Ltd', stateRegistrationNo: 'KA-CHIT-0001', address: '1 Test Road',
      phone: '8000000000', email: 'office@wfco.example.test',
      initialAdmin: { fullName: 'WF Manager', username: 'wf_manager', phone: '8000000001', email: 'manager@wfco.example.test', password: PASSWORD },
    });
    expect(res.status).toBe(201);
    companyId = res.body.data.company.id;
    expect(res.body.data.company.code).toBe('WFCO');
    expect(res.body.data.initialAdmin.credentialsEmailSent).toBe(false); // SMTP disabled in tests
  });

  it('super admin can list and view the company', async () => {
    const list = await api().get('/api/v1/super-admin/companies').set(bearer(superToken));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('Workflow Chits Pvt Ltd');
    const details = await api().get(`/api/v1/super-admin/companies/${companyId}`).set(bearer(superToken));
    expect(details.status).toBe(200);
  });

  it('the manager can log in and sees their company', async () => {
    managerToken = await login('wf_manager');
    const me = await api().get('/api/v1/auth/me').set(bearer(managerToken));
    expect(me.body.data.company.id).toBe(companyId);
  });
});

describe('3. staff creation and assignment', () => {
  it('manager creates a collection staff account (password policy enforced)', async () => {
    const weak = await api().post('/api/v1/auth/users').set(bearer(managerToken)).send({
      username: 'wf_staff', fullName: 'WF Staff', phone: '8000000002', password: 'weak', role: 'COLLECTION_STAFF',
    });
    expect(weak.status).toBe(400);
    const res = await api().post('/api/v1/auth/users').set(bearer(managerToken)).send({
      username: 'wf_staff', fullName: 'WF Staff', phone: '8000000002', password: PASSWORD, role: 'COLLECTION_STAFF',
    });
    expect(res.status).toBe(201);
    staffId = res.body.data.id;
    staffToken = await login('wf_staff');
  });
});

describe('4. chit group creation', () => {
  it('validates input', async () => {
    const bad = await api().post('/api/v1/chit-groups').set(bearer(managerToken)).send({ name: 'Bad', chitValue: -5, totalMonths: 10, maxMembers: 10 });
    expect(bad.status).toBe(400);
  });

  it('creates a 1,00,000 / 10 month group with schedule and an atomic group code', async () => {
    const res = await api().post('/api/v1/chit-groups').set(bearer(managerToken)).send({
      name: 'Lakh Group', chitValue: 100000, maxMembers: 10, totalMonths: 10, foremanCommissionPct: 5, startDate: '2026-01-10', assignedStaffId: staffId,
    });
    expect(res.status).toBe(201);
    groupId = res.body.data.id;
    expect(res.body.data.groupCode).toBe('CG-2027');
    expect(res.body.data.monthlyInstallment).toBe(10000);
    expect(typeof res.body.data.chitValue).toBe('number');
    const schedules = await prisma.installmentSchedule.findMany({ where: { groupId }, orderBy: { installmentNo: 'asc' } });
    expect(schedules).toHaveLength(10);
    expect(schedules[1].dueDate).toBe('2026-02-10');
    const second = await api().post('/api/v1/chit-groups').set(bearer(managerToken)).send({ name: 'Second', chitValue: 50000, maxMembers: 5, totalMonths: 5 });
    expect(second.body.data.groupCode).toBe('CG-2028');
  });
});

describe('5. subscriber registration', () => {
  it('manager registers members directly into the group with sequential codes and tickets', async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await api().post('/api/v1/subscribers').set(bearer(managerToken)).send({
        fullName: `Member ${i}`, phone: `700000000${i}`, groupId, nomineeName: 'Nominee',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.subscriberCode).toBe(`SUB-${1000 + i}`);
      members.push({ id: res.body.data.id, name: `Member ${i}` });
    }
    const tickets = await prisma.chitGroupMember.findMany({ where: { groupId }, orderBy: { ticketNumber: 'asc' } });
    expect(tickets.map((t) => t.ticketNumber)).toEqual([1, 2, 3]);
  });

  it('staff-registered members wait for KYC approval and are enrolled on approval', async () => {
    const res = await api().post('/api/v1/subscribers').set(bearer(staffToken)).send({ fullName: 'Member 4', phone: '7000000004', groupId });
    expect(res.status).toBe(201);
    expect(res.body.data.kycStatus).toBe('PENDING');
    expect(res.body.data.memberships).toHaveLength(0);
    const approve = await api().patch(`/api/v1/subscribers/${res.body.data.id}/kyc`).set(bearer(managerToken)).send({ kycStatus: 'VERIFIED' });
    expect(approve.status).toBe(200);
    expect(approve.body.data.memberships).toHaveLength(1);
    members.push({ id: res.body.data.id, name: 'Member 4' });
  });

  it('duplicate phone in the same company is reported, not duplicated', async () => {
    const dup = await api().post('/api/v1/subscribers').set(bearer(managerToken)).send({ fullName: 'Dup', phone: '7000000001' });
    expect(dup.status).toBe(409);
  });
});

describe('6-7. collection recording and payment verification', () => {
  let pendingId: string;

  it('validates payments', async () => {
    expect((await recordCash(managerToken, members[0].id, groupId, -10)).status).toBe(400);
    expect((await recordCash(managerToken, members[0].id, groupId, 100, 99)).status).toBe(400);
    expect((await recordCash(managerToken, members[0].id, groupId, 100, 1, { paymentMode: 'BITCOIN' })).status).toBe(400);
    expect((await recordCash(managerToken, members[0].id, groupId, 100, 1, { paymentMode: 'UPI' })).status).toBe(400); // UTR required
    expect((await recordCash(managerToken, members[0].id, groupId, 100, 1, { notes: '' })).status).toBe(400);
    expect((await recordCash(managerToken, members[0].id, groupId, 100, 1, { receiptPhoto: 'data:text/html;base64,PHNjcmlwdD4=' })).status).toBe(400);
    const second = await api().post('/api/v1/chit-groups').set(bearer(managerToken)).send({ name: 'Third', chitValue: 10000, maxMembers: 2, totalMonths: 2 });
    expect((await recordCash(managerToken, members[0].id, second.body.data.id, 100)).status).toBe(400); // not a member
  });

  it('manager collections are verified immediately with sequential receipt numbers', async () => {
    const year = new Date().getFullYear();
    const r1 = await recordCash(managerToken, members[0].id, groupId, 10000, 1);
    const r2 = await recordCash(managerToken, members[1].id, groupId, '10000.00', 1, { paymentMode: 'UPI', externalRef: 'UTR123' });
    expect(r1.status).toBe(201);
    expect(r1.body.data.verificationStatus).toBe('VERIFIED');
    expect(r1.body.data.receiptNo).toBe(`REC-${year}-00001`);
    expect(r2.body.data.receiptNo).toBe(`REC-${year}-00002`);
    expect(r1.body.data.amount).toBe(10000);
  });

  it('idempotency key prevents duplicate payments', async () => {
    const a = await recordCash(managerToken, members[2].id, groupId, 10000, 1, { idempotencyKey: 'idem-1' });
    const b = await recordCash(managerToken, members[2].id, groupId, 10000, 1, { idempotencyKey: 'idem-1' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.data.id).toBe(a.body.data.id);
  });

  it('concurrent collections never get duplicate receipt numbers', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => recordCash(managerToken, members[3].id, groupId, 100 + i, 1)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const nos = results.map((r) => r.body.data.receiptNo);
    expect(new Set(nos).size).toBe(12);
  });

  it('staff collection goes to manager approval; approval is final for reversal', async () => {
    const res = await recordCash(staffToken, members[3].id, groupId, 10000, 1);
    expect(res.body.data.verificationStatus).toBe('PENDING_VERIFICATION');
    pendingId = res.body.data.id;
    const pending = await api().get('/api/v1/collections/transactions?verificationStatus=PENDING_VERIFICATION').set(bearer(managerToken));
    expect(pending.body.stats.pendingAmount).toBe(10000);
    const approve = await api().post(`/api/v1/collections/${pendingId}/approve`).set(bearer(managerToken));
    expect(approve.status).toBe(200);
    expect(approve.body.data.verificationStatus).toBe('VERIFIED');
    expect((await api().post(`/api/v1/collections/${pendingId}/approve`).set(bearer(managerToken))).status).toBe(400);
  });

  it('reversal preserves the record and cannot be undone by approval or repeated', async () => {
    const res = await recordCash(managerToken, members[3].id, groupId, 1, 2);
    const id = res.body.data.id;
    expect((await api().post(`/api/v1/collections/${id}/reverse`).set(bearer(managerToken)).send({ reason: 'entered twice' })).status).toBe(200);
    expect((await api().post(`/api/v1/collections/${id}/reverse`).set(bearer(managerToken)).send({ reason: 'again' })).status).toBe(400);
    expect((await api().post(`/api/v1/collections/${id}/approve`).set(bearer(managerToken))).status).toBe(400);
    const tx = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id } });
    expect(tx.isReversed).toBe(true);
    expect(tx.verificationStatus).toBe('REVERSED');
    // Financial records are immutable through the API
    expect((await api().delete(`/api/v1/collections/transactions/${id}`).set(bearer(managerToken))).status).toBe(403);
  });

  it('member ledger totals are exact', async () => {
    const ledger = await api().get(`/api/v1/subscribers/${members[0].id}/ledger`).set(bearer(managerToken));
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.summary.totalPaid).toBe(10000);
    expect(ledger.body.data.groups[0].schedules[0].status).toBe('PAID');
  });

  it('decimal amounts are stored and summed exactly', async () => {
    const r = await recordCash(managerToken, members[2].id, groupId, 0.1, 3);
    const r2 = await recordCash(managerToken, members[2].id, groupId, 0.2, 3);
    expect(r.status).toBe(201);
    expect(r2.status).toBe(201);
    const ledger = await api().get(`/api/v1/subscribers/${members[2].id}/ledger`).set(bearer(managerToken));
    const inst3 = ledger.body.data.groups[0].schedules.find((s: any) => s.installmentNo === 3);
    expect(inst3.paidAmount).toBe(0.3);
    const raw = await prisma.$queryRaw<{ amount: string }[]>`SELECT amount::text FROM "PaymentTransaction" WHERE id = ${r.body.data.id}`;
    expect(raw[0].amount).toBe('0.10');
  });
});

describe('8-9. auction result entry and payout management', () => {
  let auctionId: string;

  it('rejects invalid auctions', async () => {
    const outsider = await api().post('/api/v1/subscribers').set(bearer(managerToken)).send({ fullName: 'Outsider', phone: '7000000099' });
    const notMember = await api().post('/api/v1/auctions/confirm').set(bearer(managerToken)).send({
      groupId, installmentNo: 1, auctionDate: '2026-01-25', winningBidDiscount: 10000, winnerSubscriberId: outsider.body.data.id,
    });
    expect(notMember.status).toBe(400);
    const tooBig = await api().post('/api/v1/auctions/confirm').set(bearer(managerToken)).send({
      groupId, installmentNo: 1, auctionDate: '2026-01-25', winningBidDiscount: 100000, winnerSubscriberId: members[0].id,
    });
    expect(tooBig.status).toBe(400);
  });

  it('records the auction with the existing commission/dividend formula', async () => {
    const res = await api().post('/api/v1/auctions/confirm').set(bearer(managerToken)).send({
      groupId, installmentNo: 1, auctionDate: '2026-01-25', winningBidDiscount: 15000, winnerSubscriberId: members[0].id,
    });
    expect(res.status).toBe(201);
    auctionId = res.body.data.id;
    // 5% of 1,00,000 = 5,000 commission; dividend 15,000 - 5,000 = 10,000; per member 10,000 / 10 = 1,000
    expect(res.body.data.foremanCommission).toBe(5000);
    expect(res.body.data.totalDividend).toBe(10000);
    expect(res.body.data.dividendPerMember).toBe(1000);
    expect(res.body.data.winningTicketNo).toBe(1);

    const next = await prisma.installmentSchedule.findFirstOrThrow({ where: { groupId, installmentNo: 2 } });
    expect(Number(next.dividendAmount)).toBe(1000);
    expect(Number(next.netDueAmount)).toBe(9000);

    const payout = await prisma.payout.findFirstOrThrow({ where: { auctionId } });
    expect(Number(payout.grossBidAmount)).toBe(85000);
    expect(payout.status).toBe('PENDING');
  });

  it('refuses a second auction for the same installment', async () => {
    const res = await api().post('/api/v1/auctions/confirm').set(bearer(managerToken)).send({
      groupId, installmentNo: 1, auctionDate: '2026-01-25', winningBidDiscount: 1000, winnerSubscriberId: members[1].id,
    });
    expect(res.status).toBe(409);
  });

  it('payout: deductions validated, net computed exactly, disbursement final', async () => {
    const payout = await prisma.payout.findFirstOrThrow({ where: { auctionId } });
    expect((await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(managerToken)).send({ status: 'APPROVED', deductions: 90000 })).status).toBe(400);
    const approve = await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(managerToken)).send({ status: 'APPROVED', deductions: 1234.56 });
    expect(approve.status).toBe(200);
    expect(approve.body.data.netPayoutAmount).toBe(83765.44);
    const disburse = await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(managerToken)).send({ status: 'DISBURSED', paymentMode: 'BANK_TRANSFER', transactionRef: 'NEFT1' });
    expect(disburse.status).toBe(200);
    const again = await api().patch(`/api/v1/payouts/${payout.id}/status`).set(bearer(managerToken)).send({ status: 'REJECTED' });
    expect(again.status).toBe(400);
    const list = await api().get('/api/v1/payouts').set(bearer(managerToken));
    expect(list.body.data[0].status).toBe('DISBURSED');
  });

  it('auction history is listed for the group', async () => {
    const res = await api().get(`/api/v1/auctions/group/${groupId}`).set(bearer(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].payout.netPayoutAmount).toBe(83765.44);
  });

  it('surrender / refund: staff submits, manager approves, membership removed', async () => {
    const create = await api().post('/api/v1/refunds').set(bearer(staffToken)).send({ subscriberId: members[3].id, groupId, amount: 5000, reason: 'Moving city' });
    expect(create.status).toBe(201);
    expect(create.body.data.status).toBe('SUBMITTED_TO_MANAGER');
    const approve = await api().patch(`/api/v1/refunds/${create.body.data.id}/process`).set(bearer(managerToken)).send({ status: 'APPROVED' });
    expect(approve.status).toBe(200);
    const membership = await prisma.chitGroupMember.findFirst({ where: { groupId, subscriberId: members[3].id } });
    expect(membership).toBeNull();
    const disburse = await api().patch(`/api/v1/refunds/${create.body.data.id}/process`).set(bearer(managerToken)).send({ status: 'DISBURSED' });
    expect(disburse.status).toBe(200);
    expect((await api().patch(`/api/v1/refunds/${create.body.data.id}/process`).set(bearer(managerToken)).send({ status: 'APPROVED' })).status).toBe(400);
  });
});

describe('10. accounting and reconciliation', () => {
  it('chart of accounts is created on first access', async () => {
    const res = await api().get('/api/v1/accounting/accounts').set(bearer(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(20);
  });

  it('balanced journal entries post and update balances; unbalanced ones are refused', async () => {
    const accounts = (await api().get('/api/v1/accounting/accounts').set(bearer(managerToken))).body.data;
    const cash = accounts.find((a: any) => a.code === '1001');
    const rent = accounts.find((a: any) => a.code === '5001');
    const unbalanced = await api().post('/api/v1/accounting/journal-entries').set(bearer(managerToken)).send({
      narration: 'bad', lines: [{ accountId: rent.id, type: 'DEBIT', amount: 100 }, { accountId: cash.id, type: 'CREDIT', amount: 99.99 }],
    });
    expect(unbalanced.status).toBe(400);
    const ok = await api().post('/api/v1/accounting/journal-entries').set(bearer(managerToken)).send({
      narration: 'Office rent', lines: [{ accountId: rent.id, type: 'DEBIT', amount: 0.1 }, { accountId: rent.id, type: 'DEBIT', amount: 0.2 }, { accountId: cash.id, type: 'CREDIT', amount: 0.3 }],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.entryNo).toBe('JV-000001');
    const ledger = await api().get(`/api/v1/accounting/general-ledger/${rent.id}`).set(bearer(managerToken));
    expect(ledger.body.data.account.closingBalance).toBe(0.3);
    const tb = await api().get('/api/v1/accounting/trial-balance').set(bearer(managerToken));
    expect(tb.status).toBe(200);
    expect(tb.body.data.isBalanced).toBe(true);
  });

  it('expenses, cashbook, bankbook, statements and reports respond', async () => {
    expect((await api().post('/api/v1/accounting/expenses').set(bearer(managerToken)).send({ category: 'RENT', amount: 2500.5, description: 'Rent' })).status).toBe(201);
    const exp = await api().get('/api/v1/accounting/expenses').set(bearer(managerToken));
    expect(exp.body.data.totalAmount).toBe(2500.5);
    for (const path of ['cashbook?period=MONTH', 'bankbook', 'financial-statements', 'reports']) {
      const res = await api().get(`/api/v1/accounting/${path}`).set(bearer(managerToken));
      expect(res.status, path).toBe(200);
    }
    const bank = await api().get('/api/v1/accounting/bankbook').set(bearer(managerToken));
    expect(bank.body.data.totalDeposits).toBe(10000); // the single UPI receipt
  });

  it('staff cash handover computes expected cash from verified cash receipts', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api().post('/api/v1/reconciliation/handover').set(bearer(staffToken)).send({ handoverDate: today, actualCash: 10000 });
    expect(res.status).toBe(201);
    expect(res.body.data.expectedCash).toBe(10000); // the approved staff cash collection
    expect(res.body.data.status).toBe('SUBMITTED');
    const verify = await api().patch(`/api/v1/reconciliation/handovers/${res.body.data.id}/verify`).set(bearer(managerToken)).send({});
    expect(verify.status).toBe(200);
    expect(verify.body.data.status).toBe('VERIFIED');
  });
});

describe('11-12. khata business, customer credit and ledger', () => {
  it('creates a business, customer and GAVE/GOT entries with exact balances', async () => {
    const biz = await api().post('/api/v1/khata/businesses').set(bearer(managerToken)).send({ name: 'Kirana Store', staffIds: [staffId] });
    expect(biz.status).toBe(201);
    const bizId = biz.body.data.id;
    const cust = await api().post(`/api/v1/khata/businesses/${bizId}/customers`).set(bearer(staffToken)).send({ name: 'Ravi', phone: '9999999999', openingBalance: 100.1 });
    expect(cust.status).toBe(201);
    const custId = cust.body.data.id;
    expect((await api().post(`/api/v1/khata/customers/${custId}/transactions`).set(bearer(staffToken)).send({ type: 'GAVE', amount: 0.2 })).status).toBe(201);
    expect((await api().post(`/api/v1/khata/customers/${custId}/transactions`).set(bearer(staffToken)).send({ type: 'GOT', amount: 50.05 })).status).toBe(201);
    expect((await api().post(`/api/v1/khata/customers/${custId}/transactions`).set(bearer(staffToken)).send({ type: 'GOT', amount: -5 })).status).toBe(400);
    const details = await api().get(`/api/v1/khata/customers/${custId}`).set(bearer(managerToken));
    expect(details.body.data.netBalance).toBe(50.25); // 100.10 + 0.20 - 50.05
    const list = await api().get(`/api/v1/khata/businesses/${bizId}/customers`).set(bearer(managerToken));
    expect(list.body.data.summary.totalYouWillGet).toBe(50.25);
    const cash = await api().get(`/api/v1/khata/businesses/${bizId}/cashflow`).set(bearer(managerToken));
    expect(cash.status).toBe(200);
    const businesses = await api().get('/api/v1/khata/businesses').set(bearer(staffToken));
    expect(businesses.body.data[0].netBalance).toBe(50.25);
  });
});

describe('13. reporting and notifications', () => {
  it('dashboards respond for every role', async () => {
    const m = await api().get('/api/v1/reports/dashboard').set(bearer(managerToken));
    expect(m.status).toBe(200);
    expect(m.body.data.activeGroups).toBe(3);
    expect((await api().get('/api/v1/reports/dashboard').set(bearer(staffToken))).status).toBe(200);
    const s = await api().get('/api/v1/reports/dashboard').set(bearer(superToken));
    expect(s.body.data.activeCompanies).toBe(1);
  });

  it('member outstanding report', async () => {
    const res = await api().get('/api/v1/subscribers/outstanding').set(bearer(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
  });

  it('manager notifies staff; staff sees it; collection alerts are generated', async () => {
    const sent = await api().post('/api/v1/notifications/send').set(bearer(managerToken)).send({ title: 'Collect today', message: 'Please collect installments', targetType: 'ALL_STAFF' });
    expect(sent.status).toBe(201);
    const list = await api().get('/api/v1/notifications').set(bearer(staffToken));
    expect(list.status).toBe(200);
    expect(list.body.data.some((n: any) => n.title === 'Collect today')).toBe(true);
  });

  it('super admin audit logs, health and export (secrets redacted)', async () => {
    expect((await api().get('/api/v1/super-admin/audit-logs').set(bearer(superToken))).status).toBe(200);
    expect((await api().get('/api/v1/super-admin/system-health').set(bearer(superToken))).status).toBe(200);
    const exp = await api().get('/api/v1/super-admin/export/User').set(bearer(superToken));
    expect(exp.status).toBe(200);
    expect(JSON.stringify(exp.body)).not.toContain('passwordHash');
    const tokens = await api().get('/api/v1/super-admin/export/RefreshToken').set(bearer(superToken));
    expect(tokens.status).toBe(200);
    const stored = await prisma.refreshToken.findFirstOrThrow();
    expect(JSON.stringify(tokens.body)).not.toContain(stored.token);
  });
});
