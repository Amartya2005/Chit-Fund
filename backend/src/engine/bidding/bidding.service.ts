import { Prisma } from '@prisma/client';
import { prisma, AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { D, Dec, money as parseMoney, FinanceInputError } from '../../finance/decimal.js';
import { computeAuctionOutcome } from '../../finance/chit/auction.js';
import { validatePolicy } from '../../finance/chit/policy.js';
import { chitPolicyFromValues, ResolvedValues } from '../../modules/financial-policies/resolver.js';
import { dec, todayInIndia } from '../common.js';
import { evaluateTicket } from '../eligibility/rules.js';
import { groupTicketFacts, rulesFromValues } from '../eligibility/facts.service.js';
import { lockSession, snapshotValues } from '../sessions/settlement.service.js';

type Tx = AppTransactionClient;

/** Errors of the engine's discount checks that make a bid invalid. */
const BID_ERRORS = new Set(['DISCOUNT_OUT_OF_RANGE', 'DISCOUNT_BELOW_MIN', 'DISCOUNT_ABOVE_MAX', 'DISCOUNT_ABOVE_LEGAL_LIMIT', 'DISCOUNT_NOT_MULTIPLE_OF_STEP', 'COMMISSION_EXCEEDS_DISCOUNT', 'PRIZE_NEGATIVE']);

export const effectiveClose = (s: { closesAt: Date; extendedUntil: Date | null }) => s.extendedUntil ?? s.closesAt;
export async function dbNow(tx: Tx | typeof prisma): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return new Date(rows[0].now);
}

/** Append a session event (session row must be locked by the caller). */
export async function appendEvent(tx: Tx, sessionId: string, type: string, payload: Record<string, unknown>) {
  const s = await tx.auctionSession.update({ where: { id: sessionId }, data: { lastEventSeq: { increment: 1 } }, select: { lastEventSeq: true } });
  await tx.auctionSessionEvent.create({ data: { sessionId, seq: s.lastEventSeq, type, payload: payload as Prisma.InputJsonValue } });
  return s.lastEventSeq;
}

export async function bestBid(db: Tx | typeof prisma, sessionId: string) {
  return db.auctionBid.findFirst({ where: { sessionId, status: 'ACCEPTED' }, orderBy: [{ bidDiscount: 'desc' }, { sequenceNo: 'asc' }] });
}

async function sessionValues(tx: Tx, configSnapshotId: string | null): Promise<ResolvedValues> {
  if (!configSnapshotId) throw new HttpError(409, 'The auction configuration is not locked yet.', 'CONFIG_NOT_LOCKED');
  return snapshotValues(await tx.configSnapshot.findUniqueOrThrow({ where: { id: configSnapshotId } }));
}

export interface BidInput {
  sessionId: string;
  memberId: string;
  discount: unknown;
  clientRequestId: unknown;
  source: 'ONLINE' | 'PROXY' | 'FLOOR';
  placedByUserId: string;
}

/**
 * Place one bid. Returns { accepted, bid, replay } — a rule violation is stored as a REJECTED bid and
 * returned (not thrown) so the attempt stays in the audit trail.
 */
export async function placeBid(tx: Tx, input: BidInput) {
  if (typeof input.clientRequestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(input.clientRequestId)) {
    throw new HttpError(400, 'clientRequestId (8–64 letters, digits or dashes) is required', 'VALIDATION_FAILED');
  }
  const replay = await tx.auctionBid.findUnique({ where: { sessionId_memberId_clientRequestId: { sessionId: input.sessionId, memberId: input.memberId, clientRequestId: input.clientRequestId } } });
  if (replay) return { accepted: replay.status === 'ACCEPTED', bid: replay, replay: true };

  const s = await lockSession(tx, input.sessionId);
  if (s.mode === 'OFFLINE') throw new HttpError(409, 'This auction is held offline.', 'OFFLINE_AUCTION');
  if (s.status !== 'OPEN') throw new HttpError(409, `Bidding is not open (auction is ${s.status}).`, 'AUCTION_NOT_OPEN');
  const values = await sessionValues(tx, s.configSnapshotId);
  const rules = values.bidding;
  if (input.source === 'PROXY' && rules.proxyBidding !== 'MANAGER_ON_BEHALF') throw new HttpError(403, 'Bidding on behalf of a member is not allowed (D-16).', 'PROXY_NOT_ALLOWED');
  if (input.source === 'FLOOR' && s.mode !== 'HYBRID') throw new HttpError(409, 'Floor bids are only for hybrid auctions.', 'NOT_HYBRID');
  const member = await tx.chitGroupMember.findUnique({ where: { id: input.memberId } });
  if (!member || member.groupId !== s.groupId) throw new HttpError(404, 'Ticket not found in this auction', 'NOT_FOUND');

  let discount: Dec | null = null;
  try {
    discount = parseMoney(input.discount, 'discount');
  } catch (e) {
    throw new HttpError(400, e instanceof FinanceInputError ? e.message : 'Invalid amount', 'VALIDATION_FAILED');
  }
  const now = await dbNow(tx);
  const close = effectiveClose(s);
  const reject = async (reason: string) => {
    const bid = await tx.auctionBid.create({
      data: { sessionId: s.id, companyId: s.companyId, memberId: member.id, subscriberId: member.subscriberId, bidDiscount: discount!.toFixed(2) as any, clientRequestId: input.clientRequestId as string, status: 'REJECTED', rejectReason: reason, source: input.source, placedByUserId: input.placedByUserId, bidTime: now },
    });
    return { accepted: false, bid, replay: false };
  };
  if (now < s.opensAt) return reject('NOT_STARTED');
  if (now >= close) return reject('AUCTION_CLOSED');

  // eligibility (fresh facts, overrides recorded for this session count)
  const facts = (await groupTicketFacts(tx, s.groupId, todayInIndia())).find((f) => f.memberId === member.id)!;
  const e = evaluateTicket(facts, rulesFromValues(values.eligibility));
  if (!e.eligible) {
    const ov = await tx.eligibilityDecision.findFirst({ where: { sessionId: s.id, memberId: member.id, overriddenById: { not: null } }, orderBy: { evaluatedAt: 'desc' } });
    const failing = e.results.filter((r) => !r.passed);
    if (!(ov && failing.every((r) => r.overridable && ov.overriddenRules.includes(r.rule)))) return reject(`NOT_ELIGIBLE:${failing.map((r) => r.rule).join(',')}`);
  }

  // the engine's own discount checks (bounds, step, legal limit, commission)
  const group = await tx.chitGroup.findUniqueOrThrow({ where: { id: s.groupId } });
  const tickets = (await groupTicketFacts(tx, s.groupId, todayInIndia())).map((f) => ({ ticketId: f.memberId, ticketNumber: f.ticketNumber, status: f.status as any, prizedBefore: f.wins > 0 }));
  const outcome = computeAuctionOutcome(
    { chitValue: new D(String(group.chitValue)).toFixed(2), seats: group.maxMembers, discount: discount.toFixed(2), winnerTicketId: member.id, tickets, targetPeriod: null },
    validatePolicy(chitPolicyFromValues(values))
  );
  const bad = outcome.errors.find((x) => BID_ERRORS.has(x.code));
  if (bad) return reject(bad.code);

  // increments
  const minInc = new D(rules.minIncrement);
  if (rules.format === 'OPEN_ASCENDING') {
    const best = await bestBid(tx, s.id);
    if (best && discount.lessThan(new D(String(best.bidDiscount)).plus(minInc))) return reject('BELOW_MIN_INCREMENT');
  } else {
    const own = await tx.auctionBid.findFirst({ where: { sessionId: s.id, memberId: member.id, status: 'ACCEPTED' }, orderBy: { bidDiscount: 'desc' } });
    if (own && discount.lessThan(new D(String(own.bidDiscount)).plus(minInc))) return reject('BELOW_OWN_BID_PLUS_INCREMENT');
  }

  const seq = await appendEvent(tx, s.id, 'BID', {
    ticketNumber: member.ticketNumber,
    ...(rules.format === 'OPEN_ASCENDING' ? { amount: discount.toFixed(2) } : {}),
    source: input.source,
  });
  const bid = await tx.auctionBid.create({
    data: { sessionId: s.id, companyId: s.companyId, memberId: member.id, subscriberId: member.subscriberId, bidDiscount: discount.toFixed(2) as any, clientRequestId: input.clientRequestId as string, status: 'ACCEPTED', sequenceNo: seq, source: input.source, placedByUserId: input.placedByUserId, bidTime: now },
  });
  const best = await bestBid(tx, s.id);
  await tx.auctionSession.update({ where: { id: s.id }, data: { bestBidId: best?.id ?? null } });

  // anti-sniping (D-12): a bid inside the final window extends the auction, up to maxExtensions
  const windowMs = Number(rules.antiSnipingWindowSeconds) * 1000;
  if (windowMs > 0 && close.getTime() - now.getTime() <= windowMs && s.extensions < Number(rules.maxExtensions)) {
    const until = new Date(close.getTime() + Number(rules.extensionSeconds) * 1000);
    await tx.auctionSession.update({ where: { id: s.id }, data: { extendedUntil: until, extensions: { increment: 1 } } });
    await appendEvent(tx, s.id, 'EXTENDED', { closesAt: until.toISOString(), extension: s.extensions + 1 });
  }
  return { accepted: true, bid, replay: false };
}

/** What a viewer may see of a live auction. Members never see other bidders' identities beyond the configured level. */
export async function liveState(sessionId: string, viewer: { memberId?: string; staff?: boolean }, afterSeq: number) {
  const s = await prisma.auctionSession.findUniqueOrThrow({ where: { id: sessionId } });
  const snap = s.configSnapshotId ? await prisma.configSnapshot.findUnique({ where: { id: s.configSnapshotId } }) : null;
  const rules = snap ? snapshotValues(snap).bidding : null;
  const [best, events, count, mine, now] = await Promise.all([
    bestBid(prisma, s.id),
    prisma.auctionSessionEvent.findMany({ where: { sessionId, seq: { gt: afterSeq } }, orderBy: { seq: 'asc' }, take: 200 }),
    prisma.auctionBid.count({ where: { sessionId, status: 'ACCEPTED' } }),
    viewer.memberId ? prisma.auctionBid.findMany({ where: { sessionId, memberId: viewer.memberId }, orderBy: { bidTime: 'asc' } }) : Promise.resolve([]),
    dbNow(prisma),
  ]);
  const showBest = viewer.staff || rules?.format === 'OPEN_ASCENDING' || ['CLOSED', 'PENDING_APPROVAL', 'SETTLED'].includes(s.status);
  let bestView: Record<string, unknown> | null = null;
  if (best && showBest) {
    const bm = await prisma.chitGroupMember.findUniqueOrThrow({ where: { id: best.memberId! }, include: { subscriber: { select: { fullName: true } } } });
    bestView = {
      amount: dec(best.bidDiscount as any).toFixed(2),
      ticketNumber: bm.ticketNumber,
      ...(viewer.staff || rules?.showBidderAs === 'NAME' ? { name: bm.subscriber.fullName } : {}),
      isMine: viewer.memberId === best.memberId,
      seq: best.sequenceNo,
    };
  }
  return {
    id: s.id,
    status: s.status,
    mode: s.mode,
    serverTime: now.toISOString(),
    opensAt: s.opensAt.toISOString(),
    closesAt: effectiveClose(s).toISOString(),
    extensions: s.extensions,
    rules: rules && { format: rules.format, minIncrement: rules.minIncrement, antiSnipingWindowSeconds: rules.antiSnipingWindowSeconds, extensionSeconds: rules.extensionSeconds, showBidderAs: rules.showBidderAs },
    acceptedBids: count,
    best: bestView,
    myBids: mine.map((b) => ({ amount: dec(b.bidDiscount as any).toFixed(2), status: b.status, rejectReason: b.rejectReason, seq: b.sequenceNo, at: b.bidTime })),
    lastEventSeq: s.lastEventSeq,
    events: events.map((e) => ({ seq: e.seq, type: e.type, payload: rules?.format === 'SEALED' && !viewer.staff ? { ...(e.payload as object), amount: undefined } : e.payload, at: e.createdAt })),
  };
}

/** Open / close ONLINE and HYBRID sessions whose time has come (scheduler; database clock). */
export async function autoAdvanceOnlineSessions(companyId: string): Promise<{ opened: number; closed: number; failed: { id: string; reason: string }[] }> {
  const { openSession, closeSession } = await import('../sessions/session.service.js');
  const now = await dbNow(prisma);
  const failed: { id: string; reason: string }[] = [];
  let opened = 0;
  let closed = 0;
  const toOpen = await prisma.auctionSession.findMany({ where: { companyId, status: 'SCHEDULED', mode: { in: ['ONLINE', 'HYBRID'] }, opensAt: { lte: now }, closesAt: { gt: now } }, select: { id: true } });
  for (const s of toOpen) {
    try {
      await prisma.$transaction((tx) => openSession(tx, s.id, null), { timeout: 60000 });
      opened++;
    } catch (e) {
      failed.push({ id: s.id, reason: e instanceof Error ? e.message : 'failed' });
    }
  }
  const open = await prisma.auctionSession.findMany({ where: { companyId, status: 'OPEN', mode: { in: ['ONLINE', 'HYBRID'] } } });
  for (const s of open.filter((x) => effectiveClose(x) <= now)) {
    try {
      await prisma.$transaction((tx) => closeSession(tx, s.id, null), { timeout: 60000 });
      closed++;
    } catch (e) {
      failed.push({ id: s.id, reason: e instanceof Error ? e.message : 'failed' });
    }
  }
  return { opened, closed, failed };
}
