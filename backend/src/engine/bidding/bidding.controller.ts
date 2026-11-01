import { Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { AuthRequest } from '../../middleware/auth.js';
import { HttpError, notFound, sendError } from '../../lib/http.js';
import { assertSameCompany, assertStaffAssignedToGroup } from '../../security/tenant.js';
import { dec } from '../common.js';
import { memberSubscriber } from '../member/member.controller.js';
import { submitResult } from '../sessions/settlement.service.js';
import { bestBid, liveState, placeBid } from './bidding.service.js';

const bidDto = (r: Awaited<ReturnType<typeof placeBid>>) => ({
  accepted: r.accepted,
  replay: r.replay,
  bid: { id: r.bid.id, amount: dec(r.bid.bidDiscount as any).toFixed(2), status: r.bid.status, rejectReason: r.bid.rejectReason, seq: r.bid.sequenceNo, at: r.bid.bidTime },
});

async function memberTicketFor(req: AuthRequest, sessionId: string) {
  const sub = await memberSubscriber(req);
  const s = await prisma.auctionSession.findUnique({ where: { id: sessionId } });
  if (!s || s.companyId !== sub.companyId) throw notFound('Auction not found');
  const ticket = await prisma.chitGroupMember.findUnique({ where: { groupId_subscriberId: { groupId: s.groupId, subscriberId: sub.id } } });
  if (!ticket) throw notFound('Auction not found');
  return { session: s, ticket };
}

/** POST /engine/member/sessions/:id/bids { discount, clientRequestId } */
export const memberBid = async (req: AuthRequest, res: Response) => {
  try {
    const { session, ticket } = await memberTicketFor(req, String(req.params.id));
    const r = await prisma.$transaction((tx) => placeBid(tx, { sessionId: session.id, memberId: ticket.id, discount: req.body?.discount, clientRequestId: req.body?.clientRequestId, source: 'ONLINE', placedByUserId: req.user!.id }));
    res.status(r.accepted ? 201 : 422).json({ success: r.accepted, ...(r.accepted ? {} : { code: 'BID_REJECTED', message: `Bid not accepted: ${r.bid.rejectReason}` }), data: bidDto(r) });
  } catch (err) {
    sendError(res, err);
  }
};

const afterSeqOf = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0);

/** GET /engine/member/sessions/:id/live?afterSeq= */
export const memberLive = async (req: AuthRequest, res: Response) => {
  try {
    const { session, ticket } = await memberTicketFor(req, String(req.params.id));
    res.json({ success: true, data: { ...(await liveState(session.id, { memberId: ticket.id }, afterSeqOf(req.query.afterSeq))), myTicketNumber: ticket.ticketNumber } });
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * GET /engine/member/sessions/:id/stream?afterSeq= — Server-Sent Events for up to 25 s, then the client
 * reconnects with the last seq (works on serverless hosts; polling /live is the fallback).
 */
export const memberStream = async (req: AuthRequest, res: Response) => {
  try {
    const { session, ticket } = await memberTicketFor(req, String(req.params.id));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let cursor = afterSeqOf(req.query.afterSeq);
    let open = true;
    req.on('close', () => (open = false));
    const deadline = Date.now() + Math.min(25000, Number(req.query.maxMs) || 25000);
    while (open && Date.now() < deadline) {
      const state = await liveState(session.id, { memberId: ticket.id }, cursor);
      for (const e of state.events) {
        res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        cursor = e.seq;
      }
      res.write(`event: state\ndata: ${JSON.stringify({ ...state, events: undefined })}\n\n`);
      if (!['SCHEDULED', 'OPEN'].includes(state.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
    else res.end();
  }
};

async function loadSessionForStaff(req: AuthRequest, id: string) {
  const s = await prisma.auctionSession.findUnique({ where: { id } });
  if (!s) throw notFound('Auction not found');
  assertSameCompany(req, s.companyId, 'Auction');
  await assertStaffAssignedToGroup(req, s.groupId);
  return s;
}

/** GET /engine/sessions/:id/live — managers / staff (full view). */
export const staffLive = async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSessionForStaff(req, String(req.params.id));
    res.json({ success: true, data: await liveState(s.id, { staff: true }, afterSeqOf(req.query.afterSeq)) });
  } catch (err) {
    sendError(res, err);
  }
};

/** POST /engine/sessions/:id/bids { memberId, discount, clientRequestId, source: PROXY | FLOOR } — manager. */
export const managerBid = async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSessionForStaff(req, String(req.params.id));
    const source = req.body?.source;
    if (source !== 'PROXY' && source !== 'FLOOR') throw new HttpError(400, 'source must be PROXY or FLOOR', 'VALIDATION_FAILED');
    if (typeof req.body?.memberId !== 'string') throw new HttpError(400, 'memberId is required', 'VALIDATION_FAILED');
    const r = await prisma.$transaction((tx) => placeBid(tx, { sessionId: s.id, memberId: req.body.memberId, discount: req.body?.discount, clientRequestId: req.body?.clientRequestId, source, placedByUserId: req.user!.id }));
    await prisma.auditLog.create({ data: { companyId: s.companyId, userId: req.user!.id, action: `BID_${source}`, entity: 'AuctionSession', entityId: s.id, details: JSON.stringify({ memberId: req.body.memberId, accepted: r.accepted, bidId: r.bid.id, note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : null }) } });
    res.status(r.accepted ? 201 : 422).json({ success: r.accepted, ...(r.accepted ? {} : { code: 'BID_REJECTED', message: `Bid not accepted: ${r.bid.rejectReason}` }), data: bidDto(r) });
  } catch (err) {
    sendError(res, err);
  }
};

/** POST /engine/sessions/:id/result-from-bids — settle an online/hybrid auction with its best bid. */
export const resultFromBids = async (req: AuthRequest, res: Response) => {
  try {
    const s = await loadSessionForStaff(req, String(req.params.id));
    const best = await bestBid(prisma, s.id);
    if (!best) throw new HttpError(409, 'No bids were accepted; record a no-bid outcome instead.', 'NO_BIDS');
    const st = await prisma.$transaction((tx) => submitResult(tx, s.id, best.memberId, dec(best.bidDiscount as any).toFixed(2), req.user!.id), { timeout: 60000 });
    res.status(201).json({ success: true, data: { id: st.id, status: st.status, winnerMemberId: st.winnerMemberId, winningDiscount: dec(st.winningDiscount).toFixed(2), netPrize: dec(st.netPrize).toFixed(2) } });
  } catch (err) {
    sendError(res, err);
  }
};
