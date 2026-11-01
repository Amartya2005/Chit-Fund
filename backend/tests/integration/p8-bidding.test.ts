import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { api, bearer, createTenant, createUser, login, PASSWORD, prisma, resetDb } from '../helpers.js';
import { E, activatePolicy, addMember, configureCompany, convertGroup, createGroup, enableEngine } from '../engine-helpers.js';
import { todayInIndia } from '../../src/modules/subscribers/arrears.js';
import { addDays } from '../../src/finance/schedule/recurrence.js';

/**
 * P8: online bidding. Test rules (not recommendations): open ascending, ₹500 increment, anti-sniping
 * window 3600 s (every early bid is "inside" it) with 120 s extensions, at most 2 extensions,
 * bidders shown by ticket number, proxy bidding not allowed. Group: ₹40,000, 4 seats, 5% commission
 * (₹2,000), legal max discount 40% (₹16,000).
 */
const today = todayInIndia();
const istHHMM = (offsetMin: number) => new Date(Date.now() + 330 * 60000 + offsetMin * 60000).toISOString().slice(11, 16);
let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;
let saToken: string;
let g: any;
let session: any;
const subs: any[] = [];
const tokens: string[] = [];
const rid = () => crypto.randomUUID();
const bid = (token: string, discount: string, clientRequestId = rid(), sid = session.id) =>
  api().post(`${E}/member/sessions/${sid}/bids`).set(bearer(token)).send({ discount, clientRequestId });
const live = (token: string, afterSeq = 0, sid = session.id) => api().get(`${E}/member/sessions/${sid}/live?afterSeq=${afterSeq}`).set(bearer(token));

beforeAll(async () => {
  await resetDb();
  A = await createTenant('BA');
  B = await createTenant('BB');
  saToken = await login((await createUser('SUPER_ADMIN', null, 'p8sa')).username);
  await configureCompany(A.managerToken, saToken, A.company.id, {
    SCHEDULING: { mode: 'ONLINE', lockPoint: 'AT_OPEN', noBidRule: 'CANCEL_SESSION' },
    BIDDING: { format: 'OPEN_ASCENDING', minIncrement: '500', antiSnipingWindowSeconds: 3600, extensionSeconds: 120, maxExtensions: 2, showBidderAs: 'TICKET_NUMBER', proxyBidding: 'NOT_ALLOWED' },
  });
  await enableEngine(saToken, A.company.id);
  await api().patch(`${E}/companies/${A.company.id}/member-portal`).set(bearer(saToken)).send({ enabled: true });
  g = await createGroup(A.managerToken, { name: 'Online group', chitValue: 40000, maxMembers: 4, totalMonths: 4, startDate: addDays(today, 5) });
  for (const [i, n] of ['On One', 'On Two', 'On Three', 'On Four'].entries()) subs.push(await addMember(A.managerToken, g.id, n, `94000000${i}0`));
  await convertGroup(A.managerToken, g.id);
  for (const [i, s] of subs.slice(0, 3).entries()) {
    const r = await api().post(`${E}/members/${s.id}/login`).set(bearer(A.managerToken)).send({ username: `bidder${i + 1}`, password: PASSWORD });
    expect(r.status).toBe(201);
    tokens.push(await login(`bidder${i + 1}`));
  }
});

describe('P8 — the scheduler opens online auctions at their time and freezes the rules', () => {
  it('ad-hoc online session opens automatically (database clock); config snapshot locked; OPENED event', async () => {
    const r = await api().post(`${E}/groups/${g.id}/sessions`).set(bearer(A.managerToken)).send({ date: today, opensAtLocal: istHHMM(-1), closesAtLocal: istHHMM(10) });
    expect(r.status).toBe(201);
    expect(r.body.data.mode).toBe('ONLINE');
    session = r.body.data;
    const before = await bid(tokens[0], '2000');
    expect(before.body.code).toBe('AUCTION_NOT_OPEN');
    const run = await api().post(`${E}/scheduler/run`).set(bearer(A.managerToken)).send({});
    expect(run.body.data[0].online).toMatchObject({ opened: 1, closed: 0 });
    const s = await prisma.auctionSession.findUniqueOrThrow({ where: { id: session.id } });
    expect([s.status, s.configSnapshotId !== null, s.lastEventSeq]).toEqual(['OPEN', true, 1]);
    expect(await prisma.eligibilityDecision.count({ where: { sessionId: session.id } })).toBe(4);
  });
});

describe('P8 — bidding rules', () => {
  it('discounts are checked by the engine: below commission, above the legal limit', async () => {
    const low = await bid(tokens[0], '1000');
    expect([low.status, low.body.code, low.body.data.bid.rejectReason]).toEqual([422, 'BID_REJECTED', 'COMMISSION_EXCEEDS_DISCOUNT']);
    const high = await bid(tokens[0], '16000.01');
    expect(high.body.data.bid.rejectReason).toBe('DISCOUNT_ABOVE_LEGAL_LIMIT');
    expect((await bid(tokens[0], '12.345')).status).toBe(400);
    expect((await api().post(`${E}/member/sessions/${session.id}/bids`).set(bearer(tokens[0])).send({ discount: '3000' })).status).toBe(400); // clientRequestId required
  });

  it('ascending with a minimum increment; anti-sniping extends at most twice; replays are idempotent', async () => {
    const closes0 = (await prisma.auctionSession.findUniqueOrThrow({ where: { id: session.id } })).closesAt;
    const key = rid();
    const b1 = await bid(tokens[0], '2000', key);
    expect([b1.status, b1.body.data.accepted]).toEqual([201, true]);
    const replay = await bid(tokens[0], '2000', key);
    expect(replay.body.data).toMatchObject({ replay: true, accepted: true, bid: { id: b1.body.data.bid.id } });
    expect((await bid(tokens[1], '2400')).body.data.bid.rejectReason).toBe('BELOW_MIN_INCREMENT');
    expect((await bid(tokens[1], '2500')).status).toBe(201);
    expect((await bid(tokens[2], '3000')).status).toBe(201);
    const s = await prisma.auctionSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(s.extensions).toBe(2);
    expect(s.extendedUntil!.getTime() - closes0.getTime()).toBe(240000);
  });

  it('live view: members see the best amount and ticket number (not names); events resume after a cursor', async () => {
    const v = await live(tokens[0]);
    expect(v.body.data.best).toEqual({ amount: '3000.00', ticketNumber: 3, isMine: false, seq: expect.any(Number) });
    expect(v.body.data.myBids.map((b: any) => [b.amount, b.status])).toEqual([['1000.00', 'REJECTED'], ['16000.01', 'REJECTED'], ['2000.00', 'ACCEPTED']]);
    expect(v.body.data.events.map((e: any) => e.type)).toEqual(['OPENED', 'BID', 'EXTENDED', 'BID', 'EXTENDED', 'BID']);
    const after = await live(tokens[0], v.body.data.lastEventSeq);
    expect(after.body.data.events).toEqual([]);
    const staff = await api().get(`${E}/sessions/${session.id}/live`).set(bearer(A.managerToken));
    expect(staff.body.data.best.name).toBe('On Three');
  });

  it('parallel bids are serialised: unique increasing sequence, each accepted bid ≥ previous + increment', async () => {
    const amounts = ['3500', '4000', '4500', '5000', '5500', '6000'];
    const res = await Promise.all(amounts.map((a, i) => bid(tokens[i % 3], a)));
    expect(res.every((r) => [201, 422].includes(r.status))).toBe(true);
    const accepted = await prisma.auctionBid.findMany({ where: { sessionId: session.id, status: 'ACCEPTED' }, orderBy: { sequenceNo: 'asc' } });
    const seqs = accepted.map((b) => b.sequenceNo!);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < accepted.length; i++) expect(Number(accepted[i].bidDiscount) - Number(accepted[i - 1].bidDiscount)).toBeGreaterThanOrEqual(500);
    const s = await prisma.auctionSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(s.bestBidId).toBe(accepted[accepted.length - 1].id);
  });

  it('proxy bids follow the policy; access is confined to the member’s own auctions', async () => {
    const proxy = await api().post(`${E}/sessions/${session.id}/bids`).set(bearer(A.managerToken)).send({ memberId: (await prisma.chitGroupMember.findFirstOrThrow({ where: { subscriberId: subs[3].id } })).id, discount: '9000', clientRequestId: rid(), source: 'PROXY' });
    expect(proxy.body.code).toBe('PROXY_NOT_ALLOWED');
    expect((await api().post(`${E}/sessions/${session.id}/bids`).set(bearer(tokens[0])).send({})).body.code).toBe('MEMBER_SCOPE');
    expect((await api().post(`${E}/member/sessions/${session.id}/bids`).set(bearer(A.managerToken)).send({})).status).toBe(403);
    expect((await api().get(`${E}/sessions/${session.id}/live`).set(bearer(B.managerToken))).status).toBe(404);
    const other = await createGroup(A.managerToken, { name: 'Other', chitValue: 20000, maxMembers: 2, totalMonths: 2, startDate: addDays(today, 5) });
    await addMember(A.managerToken, other.id, 'Not Bidder', '9400000999');
    await convertGroup(A.managerToken, other.id);
    const os = await api().post(`${E}/groups/${other.id}/sessions`).set(bearer(A.managerToken)).send({ date: today, opensAtLocal: istHHMM(-1), closesAtLocal: istHHMM(10) });
    expect((await live(tokens[0], 0, os.body.data.id)).status).toBe(404);
  });

  it('SSE stream delivers events and state', async () => {
    const r = await api().get(`${E}/member/sessions/${session.id}/stream?afterSeq=0&maxMs=1200`).set(bearer(tokens[0])).buffer(true).parse((res, cb) => {
      let d = '';
      res.on('data', (c: Buffer) => (d += c.toString()));
      res.on('end', () => cb(null, d));
    });
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    expect(r.body).toMatch(/event: OPENED/);
    expect(r.body).toMatch(/event: state/);
  });
});

describe('P8 — closing and settling an online auction', () => {
  it('cannot be closed early by hand; after its time the scheduler closes it; late bids are rejected', async () => {
    expect((await api().post(`${E}/sessions/${session.id}/close`).set(bearer(A.managerToken)).send({})).body.code).toBe('TOO_EARLY');
    await prisma.auctionSession.update({ where: { id: session.id }, data: { opensAt: new Date(Date.now() - 3600000), closesAt: new Date(Date.now() - 60000), extendedUntil: null } });
    expect((await bid(tokens[0], '9000')).body.data.bid.rejectReason).toBe('AUCTION_CLOSED');
    const run = await api().post(`${E}/scheduler/run`).set(bearer(A.managerToken)).send({});
    expect(run.body.data[0].online.closed).toBe(1);
    expect((await prisma.auctionSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('CLOSED');
  });

  it('the result must be the best bid; result-from-bids settles it; SETTLED event; bids immutable', async () => {
    const best = await prisma.auctionBid.findFirstOrThrow({ where: { sessionId: session.id, status: 'ACCEPTED' }, orderBy: [{ bidDiscount: 'desc' }, { sequenceNo: 'asc' }] });
    const other = await prisma.chitGroupMember.findFirstOrThrow({ where: { groupId: g.id, NOT: { id: best.memberId! } } });
    const wrong = await api().post(`${E}/sessions/${session.id}/result`).set(bearer(A.managerToken)).send({ winnerMemberId: other.id, discount: '3000' });
    expect(wrong.body.code).toBe('RESULT_MUST_MATCH_BEST_BID');
    const r = await api().post(`${E}/sessions/${session.id}/result-from-bids`).set(bearer(A.managerToken)).send({});
    expect(r.status).toBe(201);
    expect([r.body.data.status, r.body.data.winnerMemberId, r.body.data.winningDiscount]).toEqual(['SETTLED', best.memberId, Number(best.bidDiscount).toFixed(2)]);
    const events = await prisma.auctionSessionEvent.findMany({ where: { sessionId: session.id }, orderBy: { seq: 'asc' } });
    expect(events.at(-1)!.type).toBe('SETTLED');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuctionBid" SET "bidDiscount" = 1 WHERE id = '${best.id}'`)).rejects.toThrow(/immutable/);
  });

  it('sealed format (group override): amounts hidden from members while open; own bids must rise', async () => {
    await activatePolicy(A.managerToken, { scope: 'GROUP', groupId: g.id, kind: 'BIDDING', values: { format: 'SEALED' } });
    const r = await api().post(`${E}/groups/${g.id}/sessions`).set(bearer(A.managerToken)).send({ date: today, opensAtLocal: istHHMM(-1), closesAtLocal: istHHMM(10) });
    await api().post(`${E}/sessions/${r.body.data.id}/open`).set(bearer(A.managerToken)).send({});
    // the first auction's winner is no longer eligible (test rule maxWinsPerTicket = 1)
    const winner = (await prisma.auctionSettlement.findFirstOrThrow({ where: { sessionId: session.id, status: 'SETTLED' } })).winnerSubscriberId;
    const idx = subs.slice(0, 3).map((x, i) => (x.id === winner ? -1 : i)).filter((i) => i >= 0);
    const winnerIdx = subs.findIndex((x) => x.id === winner);
    const sid = r.body.data.id;
    expect((await bid(tokens[winnerIdx], '4000', rid(), sid)).body.data.bid.rejectReason).toBe('NOT_ELIGIBLE:MAX_WINS');
    expect((await bid(tokens[idx[0]], '4000', rid(), sid)).status).toBe(201);
    expect((await bid(tokens[idx[1]], '5000', rid(), sid)).status).toBe(201);
    const v = await live(tokens[idx[0]], 0, sid);
    expect(v.body.data.best).toBeNull();
    expect(v.body.data.events.filter((e: any) => e.type === 'BID').every((e: any) => e.payload.amount === undefined)).toBe(true);
    // a sealed bid may be lower than someone else's, but a bidder's own new bid must rise by the increment
    expect((await bid(tokens[idx[0]], '4200', rid(), sid)).body.data.bid.rejectReason).toBe('BELOW_OWN_BID_PLUS_INCREMENT');
    expect((await bid(tokens[idx[0]], '4500', rid(), sid)).status).toBe(201);
  });
});
