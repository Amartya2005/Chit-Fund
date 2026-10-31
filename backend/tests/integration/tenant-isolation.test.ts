import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createTenant, login, prisma, recordCash, resetDb, createUser } from '../helpers.js';

/**
 * Two companies (A and B). Every test uses company A's credentials against
 * company B's record ids and expects the request to be refused (404/403) and
 * company B's data to be unchanged.
 */
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let bTx: any;
let bPendingTx: any;
let bPayout: any;
let bAccountId: string;

beforeAll(async () => {
  await resetDb();
  A = await createTenant('TA');
  B = await createTenant('TB');

  bTx = (await recordCash(B.managerToken, B.subscriber.id, B.group.id, 5000)).body.data;
  bPendingTx = (await recordCash(B.staffToken, B.subscriber.id, B.group.id, 5000, 2)).body.data;
  const auction = await api().post('/api/v1/auctions/confirm').set(bearer(B.managerToken)).send({
    groupId: B.group.id, installmentNo: 1, auctionDate: '2026-02-05', winningBidDiscount: 10000, winnerSubscriberId: B.subscriber.id,
  });
  expect(auction.status).toBe(201);
  bPayout = await prisma.payout.findFirstOrThrow({ where: { auctionId: auction.body.data.id } });
  const accounts = await api().get('/api/v1/accounting/accounts').set(bearer(B.managerToken));
  bAccountId = accounts.body.data[0].id;
});

describe('list endpoints only return the caller company', () => {
  it.each([
    ['/api/v1/subscribers', (b: any) => b.data],
    ['/api/v1/chit-groups', (b: any) => b.data],
    ['/api/v1/collections/transactions', (b: any) => b.data],
    ['/api/v1/payouts', (b: any) => b.data],
    ['/api/v1/auth/users', (b: any) => b.data],
  ])('%s', async (path, pick) => {
    const res = await api().get(path).set(bearer(A.managerToken));
    expect(res.status).toBe(200);
    const text = JSON.stringify(pick(res.body));
    expect(text).not.toContain(B.group.id);
    expect(text).not.toContain(B.subscriber.id);
    expect(text).not.toContain(B.manager.id);
  });

  it('notifications of another company are not visible', async () => {
    const sent = await api().post('/api/v1/notifications/send').set(bearer(B.managerToken)).send({
      title: 'B internal notice', message: 'Only for company B staff', targetType: 'ALL_STAFF',
    });
    expect(sent.status).toBe(201);
    const listA = await api().get('/api/v1/notifications').set(bearer(A.staffToken));
    expect(JSON.stringify(listA.body.data)).not.toContain('B internal notice');
    const listB = await api().get('/api/v1/notifications').set(bearer(B.staffToken));
    expect(JSON.stringify(listB.body.data)).toContain('B internal notice');
  });
});

describe('id manipulation across companies is refused', () => {
  it('cannot read another company group, subscriber, ledger or statement', async () => {
    const t = bearer(A.managerToken);
    expect((await api().get(`/api/v1/chit-groups/${B.group.id}`).set(t)).status).toBe(404);
    expect((await api().get(`/api/v1/subscribers/${B.subscriber.id}`).set(t)).status).toBe(404);
    expect((await api().get(`/api/v1/subscribers/${B.subscriber.id}/ledger`).set(t)).status).toBe(404);
    expect((await api().get(`/api/v1/subscribers/${B.subscriber.id}/statement`).set(t)).status).toBe(404);
    expect((await api().get(`/api/v1/auctions/group/${B.group.id}`).set(t)).status).toBe(404);
    expect((await api().get(`/api/v1/collections/receipts/${bTx.receiptNo}`).set(t)).status).not.toBe(200);
  });

  it('cannot modify another company group or subscriber', async () => {
    const t = bearer(A.managerToken);
    expect((await api().put(`/api/v1/chit-groups/${B.group.id}`).set(t).send({ name: 'hacked' })).status).toBe(404);
    expect((await api().post(`/api/v1/chit-groups/${B.group.id}/assign-staff`).set(t).send({ assignedStaffId: A.staff.id })).status).toBe(404);
    expect((await api().put(`/api/v1/subscribers/${B.subscriber.id}`).set(t).send({ fullName: 'hacked' })).status).toBe(404);
    expect((await api().patch(`/api/v1/subscribers/${B.subscriber.id}/kyc`).set(t).send({ kycStatus: 'REJECTED' })).status).toBe(404);
    expect((await api().delete(`/api/v1/subscribers/${B.subscriber.id}`).set(t)).status).toBe(404);
    const g = await prisma.chitGroup.findUniqueOrThrow({ where: { id: B.group.id } });
    expect(g.name).toBe('Group TB');
    expect(g.assignedStaffId).toBe(B.staff.id);
  });

  it('cannot enroll or pay into another company group', async () => {
    const t = bearer(A.managerToken);
    expect((await api().post('/api/v1/chit-groups/enroll').set(t).send({ groupId: B.group.id, subscriberId: A.subscriber.id })).status).toBe(404);
    const pay = await recordCash(A.managerToken, B.subscriber.id, B.group.id, 1);
    expect(pay.status).toBe(404);
    const mixed = await recordCash(A.managerToken, B.subscriber.id, A.group.id, 1);
    expect(mixed.status).toBe(404);
  });

  it('cannot approve, reject, reverse or edit another company transaction', async () => {
    const t = bearer(A.managerToken);
    expect((await api().post(`/api/v1/collections/${bPendingTx.id}/approve`).set(t)).status).toBe(404);
    expect((await api().post(`/api/v1/collections/${bPendingTx.id}/reject`).set(t).send({ reason: 'x' })).status).toBe(404);
    expect((await api().post(`/api/v1/collections/${bTx.id}/reverse`).set(t).send({ reason: 'x' })).status).toBe(404);
    expect((await api().patch(`/api/v1/collections/${bTx.id}/photo`).set(t).send({ receiptPhoto: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' })).status).toBe(404);
    const rec = await api().post('/api/v1/collections/reconcile').set(t).send({ transactionIds: [bPendingTx.id], status: 'VERIFIED' });
    expect(rec.body.count).toBe(0);
    const tx = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: bPendingTx.id } });
    expect(tx.verificationStatus).toBe('PENDING_VERIFICATION');
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: bTx.id } })).isReversed).toBe(false);
  });

  it('cannot record an auction or update a payout of another company', async () => {
    const t = bearer(A.managerToken);
    const auction = await api().post('/api/v1/auctions/confirm').set(t).send({
      groupId: B.group.id, installmentNo: 2, auctionDate: '2026-03-05', winningBidDiscount: 1, winnerSubscriberId: B.subscriber.id,
    });
    expect(auction.status).toBe(404);
    const payout = await api().patch(`/api/v1/payouts/${bPayout.id}/status`).set(t).send({ status: 'DISBURSED', deductions: 0 });
    expect(payout.status).toBe(404);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: bPayout.id } })).status).toBe('PENDING');
  });

  it('cannot post journal entries into or read the ledger of another company account', async () => {
    const t = bearer(A.managerToken);
    const accountsA = (await api().get('/api/v1/accounting/accounts').set(t)).body.data;
    const je = await api().post('/api/v1/accounting/journal-entries').set(t).send({
      narration: 'cross tenant', lines: [
        { accountId: bAccountId, type: 'DEBIT', amount: 100 },
        { accountId: accountsA[1].id, type: 'CREDIT', amount: 100 },
      ],
    });
    expect(je.status).toBe(404);
    expect((await api().get(`/api/v1/accounting/general-ledger/${bAccountId}`).set(t)).status).toBe(404);
  });

  it('cannot manage users of another company', async () => {
    const t = bearer(A.managerToken);
    expect((await api().put(`/api/v1/auth/users/${B.staff.id}`).set(t).send({ fullName: 'hacked', companyId: A.company.id })).status).toBe(404);
    expect((await api().patch(`/api/v1/auth/users/${B.staff.id}/status`).set(t).send({ status: 'SUSPENDED' })).status).toBe(404);
    expect((await api().post(`/api/v1/auth/users/${B.manager.id}/revoke-sessions`).set(t)).status).toBe(404);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: B.staff.id } });
    expect(u.status).toBe('ACTIVE');
    expect(u.companyId).toBe(B.company.id);
  });

  it('ignores a client-supplied companyId when creating records', async () => {
    const t = bearer(A.managerToken);
    const user = await api().post('/api/v1/auth/users').set(t).send({
      username: 'planted_staff', fullName: 'Planted', phone: '9222222222', password: 'Str0ng!Pass', role: 'COLLECTION_STAFF', companyId: B.company.id,
    });
    expect(user.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.body.data.id } })).companyId).toBe(A.company.id);

    const exp = await api().post('/api/v1/accounting/expenses').set(t).send({ category: 'MISC', amount: 10, description: 'x', companyId: B.company.id });
    expect(exp.status).toBe(201);
    expect(exp.body.data.companyId).toBe(A.company.id);
  });

  it('cannot assign another company staff member to a group', async () => {
    const res = await api().post(`/api/v1/chit-groups/${A.group.id}/assign-staff`).set(bearer(A.managerToken)).send({ assignedStaffId: B.staff.id });
    expect(res.status).toBe(400);
  });

  it('khata: cannot open another company business', async () => {
    const biz = await api().post('/api/v1/khata/businesses').set(bearer(B.managerToken)).send({ name: 'B Shop' });
    expect(biz.status).toBe(201);
    const t = bearer(A.managerToken);
    expect((await api().get(`/api/v1/khata/businesses/${biz.body.data.id}/customers`).set(t)).status).toBe(403);
    expect((await api().get(`/api/v1/khata/businesses/${biz.body.data.id}/staff`).set(t)).status).toBe(403);
    expect((await api().put(`/api/v1/khata/businesses/${biz.body.data.id}`).set(t).send({ name: 'hacked' })).status).toBe(403);
  });
});

describe('collection staff restrictions inside a company', () => {
  it('staff cannot record or view collections for a group not assigned to them', async () => {
    const otherStaff = await createUser('COLLECTION_STAFF', A.company.id, 'ta_s2');
    const token = await login(otherStaff.username);
    const res = await recordCash(token, A.subscriber.id, A.group.id, 100);
    expect(res.status).toBe(403);
    expect((await api().get(`/api/v1/chit-groups/${A.group.id}`).set(bearer(token))).status).toBe(403);
    expect((await api().get(`/api/v1/subscribers/${A.subscriber.id}`).set(bearer(token))).status).toBe(403);
  });

  it('staff collections need manager approval', async () => {
    const res = await recordCash(A.staffToken, A.subscriber.id, A.group.id, 100);
    expect(res.status).toBe(201);
    expect(res.body.data.verificationStatus).toBe('PENDING_VERIFICATION');
    expect((await api().post(`/api/v1/collections/${res.body.data.id}/approve`).set(bearer(A.staffToken))).status).toBe(403);
  });

  it('staff cannot see colleagues identity documents', async () => {
    await prisma.user.update({ where: { id: A.manager.id }, data: { aadhaarNo: '123412341234', panNo: 'ABCDE1234F' } });
    const res = await api().get('/api/v1/auth/users').set(bearer(A.staffToken));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data)).not.toContain('123412341234');
  });
});
