import { Prisma } from '@prisma/client';
import { AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { D, Dec, ZERO, money as parseMoney, FinanceInputError } from '../../finance/decimal.js';
import { computeAuctionOutcome, AuctionOutcome } from '../../finance/chit/auction.js';
import { validatePolicy, ChitPolicy } from '../../finance/chit/policy.js';
import { buildCalculationRecord } from '../../finance/canonical.js';
import { lockConfigSnapshot } from '../../modules/financial-policies/policy.service.js';
import { chitPolicyFromValues, ResolvedValues } from '../../modules/financial-policies/resolver.js';
import { dec, lockGroupRow, requireEngineGroup, todayInIndia } from '../common.js';
import { dueViews } from '../dues/dues.service.js';
import { evaluateTicket } from '../eligibility/rules.js';
import { groupTicketFacts, rulesFromValues } from '../eligibility/facts.service.js';
import { istDate, recordEvent } from '../accounting/events.service.js';

type Tx = AppTransactionClient;

/** Lock the session row and return it. */
export async function lockSession(tx: Tx, sessionId: string) {
  await tx.$queryRaw`SELECT "id" FROM "AuctionSession" WHERE "id" = ${sessionId} FOR UPDATE`;
  return tx.auctionSession.findUniqueOrThrow({ where: { id: sessionId } });
}

/** The frozen configuration of a session (locks it now if the lock point has not been reached yet). */
export async function sessionSnapshot(tx: Tx, session: { id: string; companyId: string; groupId: string; configSnapshotId: string | null }, userId: string | null) {
  if (session.configSnapshotId) return tx.configSnapshot.findUniqueOrThrow({ where: { id: session.configSnapshotId } });
  const { snapshot } = await lockConfigSnapshot(tx, { companyId: session.companyId, subjectType: 'AUCTION_SESSION', subjectId: session.id, groupId: session.groupId, lockedById: userId });
  await tx.auctionSession.update({ where: { id: session.id }, data: { configSnapshotId: snapshot.id } });
  return snapshot;
}

export const snapshotValues = (s: { resolved: Prisma.JsonValue }) => (s.resolved as { values: ResolvedValues }).values;

interface Computation {
  outcome: AuctionOutcome;
  policy: ChitPolicy;
  inputs: Record<string, unknown>;
  winner: { memberId: string; subscriberId: string; ticketNumber: number };
  deductions: Dec;
  targetPeriodNo: number | null;
  approvalNeeded: boolean;
  eligibility: ReturnType<typeof evaluateTicket>;
}

/**
 * Compute a session result with the engine and the session's frozen configuration. No writes except
 * the snapshot lock (when the lock point is "at result entry").
 */
export async function computeResult(tx: Tx, sessionId: string, winnerMemberId: unknown, discountInput: unknown, userId: string, opts: { overrideAllowed?: boolean } = {}): Promise<Computation & { snapshotId: string }> {
  const session = await tx.auctionSession.findUniqueOrThrow({ where: { id: sessionId } });
  const group = await tx.chitGroup.findUniqueOrThrow({ where: { id: session.groupId } });
  requireEngineGroup(group);
  let discount: Dec;
  try {
    discount = parseMoney(discountInput, 'discount');
  } catch (e) {
    throw new HttpError(400, e instanceof FinanceInputError ? e.message : 'Invalid discount', 'VALIDATION_FAILED');
  }
  if (typeof winnerMemberId !== 'string' || !winnerMemberId) throw new HttpError(400, 'winnerMemberId is required', 'VALIDATION_FAILED');
  const snapshot = await sessionSnapshot(tx, session, userId);
  const values = snapshotValues(snapshot);
  const policy = validatePolicy(chitPolicyFromValues(values));

  const asOf = todayInIndia();
  const facts = await groupTicketFacts(tx, group.id, asOf);
  const winnerFacts = facts.find((f) => f.memberId === winnerMemberId);
  if (!winnerFacts) throw new HttpError(404, 'The winning ticket is not part of this group.', 'WINNER_NOT_FOUND');
  const member = await tx.chitGroupMember.findUniqueOrThrow({ where: { id: winnerMemberId } });

  // eligibility (P6): fresh evaluation, or a recorded override for this session
  const eligibility = evaluateTicket(winnerFacts, rulesFromValues(values.eligibility));
  if (!eligibility.eligible) {
    const override = opts.overrideAllowed !== false
      ? await tx.eligibilityDecision.findFirst({ where: { sessionId, memberId: winnerMemberId, overriddenById: { not: null } }, orderBy: { evaluatedAt: 'desc' } })
      : null;
    const failing = eligibility.results.filter((r) => !r.passed);
    const covered = override && failing.every((r) => r.overridable && ((override.overriddenRules as string[]) ?? []).includes(r.rule));
    if (!covered) throw new HttpError(422, `Ticket #${member.ticketNumber} is not eligible: ${failing.map((r) => r.message).join(' ')}`, 'WINNER_NOT_ELIGIBLE', { eligibility });
  }

  // contribution period that receives the dividend (D-07)
  const periods = await tx.contributionPeriod.findMany({ where: { groupId: group.id }, orderBy: { periodNo: 'asc' } });
  const timing = policy.dividend.timing;
  let target: { periodNo: number; baseAmount: string } | null = null;
  if (timing === 'NEXT_PERIOD_CREDIT') {
    const p = periods.find((x) => x.dueDate > session.scheduledDate);
    target = p ? { periodNo: p.periodNo, baseAmount: dec(p.baseAmount).toFixed(2) } : null;
  } else if (timing === 'SAME_PERIOD_CREDIT') {
    const p = [...periods].reverse().find((x) => x.dueDate <= session.scheduledDate) ?? periods[0];
    target = p ? { periodNo: p.periodNo, baseAmount: dec(p.baseAmount).toFixed(2) } : null;
  }

  // prize deductions (D-15)
  let deductions = ZERO;
  if (values.settlement.prizeDeductions === 'OVERDUE_DUES') {
    const own = await tx.memberDue.findMany({ where: { memberId: winnerMemberId } });
    deductions = new D(dueViews(own, asOf).totals.overdue);
  }

  const tickets = facts.map((f) => ({ ticketId: f.memberId, ticketNumber: f.ticketNumber, status: f.status as 'ACTIVE' | 'SURRENDERED' | 'EXITED', prizedBefore: f.wins > 0 }));
  const inputs = {
    chitValue: new D(String(group.chitValue)).toFixed(2),
    seats: group.maxMembers,
    discount: discount.toFixed(2),
    winnerTicketId: winnerMemberId,
    tickets,
    targetPeriod: target,
    deductions: deductions.greaterThan(0) ? [{ type: 'OVERDUE_DUES', amount: deductions.toFixed(2) }] : [],
  };
  const outcome = computeAuctionOutcome(inputs, policy);

  // credits must fit each ticket's due for the target period
  if (outcome.valid && target && outcome.allocations.some((a) => a.kind === 'TICKET_SHARE')) {
    const dues = await tx.memberDue.findMany({ where: { groupId: group.id, periodNo: target.periodNo } });
    for (const a of outcome.allocations.filter((x) => x.kind === 'TICKET_SHARE')) {
      const due = dues.find((d) => d.memberId === a.ticketId);
      if (!due) throw new HttpError(409, `Ticket #${a.ticketNumber} has no due for period #${target.periodNo} to credit.`, 'DUE_MISSING');
      if (dec(due.dividendCredit).plus(dec(due.contributionWaived)).plus(a.amount).greaterThan(dec(due.grossAmount))) {
        outcome.valid = false;
        outcome.errors.push({ code: 'DIVIDEND_EXCEEDS_DUE', message: `Ticket #${a.ticketNumber}: total dividend credit would exceed the period #${target.periodNo} instalment.` });
      }
    }
  }

  const st = values.settlement;
  const approvalNeeded = st.settlementApproval === 'SECOND_PERSON' || (st.settlementApproval === 'ABOVE_THRESHOLD' && new D(outcome.netPrize).greaterThan(st.approvalThreshold));
  return {
    outcome,
    policy,
    inputs,
    winner: { memberId: member.id, subscriberId: member.subscriberId, ticketNumber: member.ticketNumber },
    deductions,
    targetPeriodNo: target?.periodNo ?? null,
    approvalNeeded,
    eligibility,
    snapshotId: snapshot.id,
  };
}

/** Record a result: calculation run + settlement (pending approval or settled at once). */
export async function submitResult(tx: Tx, sessionId: string, winnerMemberId: unknown, discount: unknown, userId: string) {
  const s0 = await tx.auctionSession.findUniqueOrThrow({ where: { id: sessionId } });
  await lockGroupRow(tx, s0.groupId);
  const session = await lockSession(tx, sessionId);
  if (session.status !== 'CLOSED') throw new HttpError(409, `Results can be entered only for a closed auction (this one is ${session.status}).`, 'INVALID_STATE');
  if (session.mode !== 'OFFLINE') {
    // online / hybrid: the result is the best accepted bid (highest discount, earliest on ties — D-12)
    const best = await tx.auctionBid.findFirst({ where: { sessionId, status: 'ACCEPTED' }, orderBy: [{ bidDiscount: 'desc' }, { sequenceNo: 'asc' }] });
    if (!best) throw new HttpError(409, 'No bids were accepted; record a no-bid outcome instead.', 'NO_BIDS');
    if (best.memberId !== winnerMemberId || !dec(best.bidDiscount as any).equals(String(discount))) {
      throw new HttpError(409, 'The result of an online auction must be its best bid.', 'RESULT_MUST_MATCH_BEST_BID', { memberId: best.memberId, discount: dec(best.bidDiscount as any).toFixed(2) });
    }
  }
  const c = await computeResult(tx, sessionId, winnerMemberId, discount, userId);
  if (!c.outcome.valid) throw new HttpError(422, c.outcome.errors.map((e) => e.message).join(' '), 'RESULT_INVALID', { errors: c.outcome.errors, outcome: c.outcome });

  const record = buildCalculationRecord('AUCTION_SETTLEMENT', c.inputs, c.policy, c.outcome);
  const run = await tx.calculationRun.create({
    data: {
      companyId: session.companyId,
      engine: 'CHIT',
      kind: 'AUCTION_SETTLEMENT',
      engineVersion: record.engineVersion,
      configSnapshotId: c.snapshotId,
      inputs: record.inputs as unknown as Prisma.InputJsonValue,
      policy: record.policy as unknown as Prisma.InputJsonValue,
      outputs: JSON.parse(JSON.stringify(record.outputs)) as Prisma.InputJsonValue,
      inputHash: record.inputHash,
      policyHash: record.policyHash,
      outputHash: record.outputHash,
      createdById: userId,
    },
  });
  const revision = ((await tx.auctionSettlement.aggregate({ where: { sessionId }, _max: { revision: true } }))._max.revision ?? 0) + 1;
  const o = c.outcome;
  const settlement = await tx.auctionSettlement.create({
    data: {
      companyId: session.companyId,
      groupId: session.groupId,
      sessionId,
      revision,
      calculationRunId: run.id,
      winnerMemberId: c.winner.memberId,
      winnerSubscriberId: c.winner.subscriberId,
      winningDiscount: new D(c.inputs.discount as string).toFixed(2),
      commission: o.commission,
      commissionShortfall: o.commissionShortfall,
      dividendPool: o.dividendPool,
      dividendPerShare: o.dividendPerShare,
      roundingRemainder: o.roundingRemainder,
      dividendCredited: o.creditedTotal,
      dividendUnallocated: o.unallocatedTotal,
      grossPrize: o.grossPrize,
      deductions: o.deductionsTotal,
      netPrize: o.netPrize,
      targetPeriodNo: c.targetPeriodNo,
      status: c.approvalNeeded ? 'PENDING_APPROVAL' : 'SETTLED',
      submittedById: userId,
    },
  });
  for (const a of o.allocations) {
    await tx.dividendRecord.create({
      data: {
        companyId: session.companyId,
        settlementId: settlement.id,
        key: a.key,
        kind: a.kind,
        status: a.status,
        amount: a.amount,
        memberId: a.ticketId ?? null,
        subscriberId: a.ticketId ? (await tx.chitGroupMember.findUniqueOrThrow({ where: { id: a.ticketId }, select: { subscriberId: true } })).subscriberId : null,
        targetPeriodNo: a.periodNo ?? null,
      },
    });
  }
  await tx.auditLog.create({
    data: {
      companyId: session.companyId,
      userId,
      action: 'AUCTION_RESULT_SUBMITTED',
      entity: 'AuctionSettlement',
      entityId: settlement.id,
      details: JSON.stringify({ sessionId, revision, winner: c.winner, discount: c.inputs.discount, approvalNeeded: c.approvalNeeded, outputHash: record.outputHash }),
    },
  });
  if (c.approvalNeeded) {
    await tx.auctionSession.update({ where: { id: sessionId }, data: { status: 'PENDING_APPROVAL', rowVersion: { increment: 1 } } });
    return tx.auctionSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
  }
  return applySettlement(tx, settlement.id, userId);
}

/** Make a settlement effective: dues credits, legacy projections, accounting events. */
export async function applySettlement(tx: Tx, settlementId: string, approverId: string) {
  const st = await tx.auctionSettlement.findUniqueOrThrow({ where: { id: settlementId }, include: { dividends: true, session: true } });
  const group = await tx.chitGroup.findUniqueOrThrow({ where: { id: st.groupId } });
  const winner = await tx.chitGroupMember.findUniqueOrThrow({ where: { id: st.winnerMemberId } });
  let credited = ZERO;
  for (const r of st.dividends.filter((x) => x.status === 'CREDIT_TO_PERIOD')) {
    const due = await tx.memberDue.findUniqueOrThrow({ where: { memberId_periodNo: { memberId: r.memberId!, periodNo: r.targetPeriodNo! } } });
    await tx.memberDue.update({ where: { id: due.id }, data: { dividendCredit: { increment: r.amount } } });
    await tx.dividendRecord.update({ where: { id: r.id }, data: { appliedDueId: due.id } });
    credited = credited.plus(dec(r.amount));
  }
  // legacy group-level schedule shows the per-ticket dividend of the target instalment
  if (st.targetPeriodNo && dec(st.dividendPerShare).greaterThan(0) && st.dividends.some((x) => x.status === 'CREDIT_TO_PERIOD')) {
    const inst = await tx.installmentSchedule.findUnique({ where: { groupId_installmentNo: { groupId: group.id, installmentNo: st.targetPeriodNo } } });
    if (inst) {
      const div = dec(inst.dividendAmount).plus(dec(st.dividendPerShare));
      await tx.installmentSchedule.update({ where: { id: inst.id }, data: { dividendAmount: div.toFixed(2), netDueAmount: D.max(ZERO, dec(inst.scheduledAmount).minus(div)).toFixed(2) } });
    }
  }
  // legacy projections (existing screens, payouts, reports)
  const auctionNo = ((await tx.auction.aggregate({ where: { groupId: group.id }, _max: { installmentNo: true } }))._max.installmentNo ?? 0) + 1;
  const run = await tx.calculationRun.findUniqueOrThrow({ where: { id: st.calculationRunId } });
  const auction = await tx.auction.create({
    data: {
      groupId: group.id,
      installmentNo: auctionNo,
      auctionDate: st.session.scheduledDate,
      winningBidDiscount: st.winningDiscount.toFixed(2) as any,
      foremanCommission: st.commission.toFixed(2) as any,
      totalDividend: st.dividendPool.toFixed(2) as any,
      dividendPerMember: st.dividendPerShare.toFixed(2) as any,
      winnerSubscriberId: st.winnerSubscriberId,
      winningTicketNo: winner.ticketNumber,
      winnerMemberId: winner.id,
      status: 'CONFIRMED',
      notes: `Engine settlement ${st.id} (session #${st.session.sequenceNo}, revision ${st.revision})`,
      calculation: { settlementId: st.id, calculationRunId: run.id, outputHash: run.outputHash } as Prisma.InputJsonValue,
      calculationVersion: `engine-${run.engineVersion}`,
    },
  });
  await tx.payout.create({
    data: { auctionId: auction.id, subscriberId: st.winnerSubscriberId, grossBidAmount: st.grossPrize.toFixed(2) as any, deductions: st.deductions.toFixed(2) as any, netPayoutAmount: st.netPrize.toFixed(2) as any, status: 'PENDING' },
  });
  await tx.auctionSettlement.update({ where: { id: st.id }, data: { status: 'SETTLED', settledAt: new Date(), approvedById: approverId, auctionId: auction.id } });
  await tx.auctionSession.update({ where: { id: st.sessionId }, data: { status: 'SETTLED', resultAuctionId: auction.id, rowVersion: { increment: 1 } } });
  if (st.session.mode !== 'OFFLINE') {
    const { appendEvent } = await import('../bidding/bidding.service.js');
    await appendEvent(tx, st.sessionId, 'SETTLED', { winnerTicketNumber: winner.ticketNumber, discount: st.winningDiscount.toFixed(2) });
  }

  const on = istDate(new Date());
  await recordEvent(tx, {
    companyId: st.companyId,
    type: 'AUCTION_SETTLED',
    sourceType: 'AuctionSettlement',
    sourceId: st.id,
    idempotencyKey: `AUCTION_SETTLED:${st.id}`,
    occurredOn: on,
    amount: new D(String(group.chitValue)).toFixed(2),
    payload: {
      chitValue: new D(String(group.chitValue)).toFixed(2),
      grossPrize: st.grossPrize.toFixed(2),
      commission: st.commission.toFixed(2),
      dividendCredited: st.dividendCredited.toFixed(2),
      dividendUnallocated: st.dividendUnallocated.toFixed(2),
      sessionSequenceNo: st.session.sequenceNo,
    },
    groupId: group.id,
    subscriberId: st.winnerSubscriberId,
  });
  if (credited.greaterThan(0)) {
    await recordEvent(tx, {
      companyId: st.companyId,
      type: 'DIVIDEND_APPLIED',
      sourceType: 'AuctionSettlement',
      sourceId: st.id,
      idempotencyKey: `DIVIDEND_APPLIED:${st.id}`,
      occurredOn: on,
      amount: credited.toFixed(2),
      payload: { amount: credited.toFixed(2), targetPeriodNo: st.targetPeriodNo },
      groupId: group.id,
    });
  }
  await tx.auditLog.create({ data: { companyId: st.companyId, userId: approverId, action: 'AUCTION_SETTLED', entity: 'AuctionSettlement', entityId: st.id, details: JSON.stringify({ auctionId: auction.id, credited: credited.toFixed(2) }) } });
  return tx.auctionSettlement.findUniqueOrThrow({ where: { id: st.id } });
}

export async function decidePending(tx: Tx, settlementId: string, decision: 'APPROVE' | 'REJECT', userId: string, note: string | null) {
  const pre = await tx.auctionSettlement.findUniqueOrThrow({ where: { id: settlementId } });
  await lockGroupRow(tx, pre.groupId);
  await lockSession(tx, pre.sessionId);
  const st = await tx.auctionSettlement.findUniqueOrThrow({ where: { id: settlementId } });
  if (st.status !== 'PENDING_APPROVAL') throw new HttpError(409, `This result is ${st.status.toLowerCase()}.`, 'INVALID_STATE');
  if (st.submittedById === userId) throw new HttpError(403, 'A second person must approve or reject this result.', 'SAME_PERSON');
  await tx.auditLog.create({ data: { companyId: st.companyId, userId, action: decision === 'APPROVE' ? 'AUCTION_RESULT_APPROVED' : 'AUCTION_RESULT_REJECTED', entity: 'AuctionSettlement', entityId: st.id, details: JSON.stringify({ note }) } });
  if (decision === 'REJECT') {
    await tx.auctionSettlement.update({ where: { id: st.id }, data: { status: 'REJECTED', approvedById: userId, decisionNote: note } });
    await tx.auctionSession.update({ where: { id: st.sessionId }, data: { status: 'CLOSED', rowVersion: { increment: 1 } } });
    return tx.auctionSettlement.findUniqueOrThrow({ where: { id: st.id } });
  }
  await tx.auctionSettlement.update({ where: { id: st.id }, data: { decisionNote: note } });
  return applySettlement(tx, st.id, userId);
}

/**
 * Reverse a settled result (e.g. entered wrongly). Allowed only while its payout is still PENDING and
 * no later result of the group is settled. The settlement, calculation and dividend records stay as
 * history (REVERSED); the legacy Auction/Payout projections are removed; dues credits are undone;
 * accounting events are reversed. The session returns to CLOSED for a corrected result (revision + 1).
 */
export async function reverseSettlement(tx: Tx, settlementId: string, userId: string, reason: string) {
  const pre = await tx.auctionSettlement.findUniqueOrThrow({ where: { id: settlementId } });
  await lockGroupRow(tx, pre.groupId);
  await lockSession(tx, pre.sessionId);
  const st = await tx.auctionSettlement.findUniqueOrThrow({ where: { id: settlementId }, include: { dividends: true } });
  if (st.status !== 'SETTLED') throw new HttpError(409, `Only a settled result can be reversed (this one is ${st.status}).`, 'INVALID_STATE');
  const later = await tx.auctionSettlement.count({ where: { groupId: st.groupId, status: 'SETTLED', settledAt: { gt: st.settledAt! } } });
  if (later) throw new HttpError(409, 'A later auction of this group is already settled; reverse that one first.', 'LATER_SETTLEMENT_EXISTS');
  const payout = st.auctionId ? await tx.payout.findUnique({ where: { auctionId: st.auctionId } }) : null;
  if (payout && payout.status !== 'PENDING') throw new HttpError(409, `The prize payout is already ${payout.status.toLowerCase()}; it cannot be reversed here.`, 'PAYOUT_IN_PROGRESS');

  const now = new Date();
  for (const r of st.dividends.filter((x) => x.appliedDueId && !x.reversedAt)) {
    await tx.$queryRaw`SELECT "id" FROM "MemberDue" WHERE "id" = ${r.appliedDueId} FOR UPDATE`;
    await tx.memberDue.update({ where: { id: r.appliedDueId! }, data: { dividendCredit: { decrement: r.amount } } });
  }
  for (const r of st.dividends.filter((x) => !x.reversedAt)) await tx.dividendRecord.update({ where: { id: r.id }, data: { reversedAt: now } });
  if (st.targetPeriodNo && st.dividends.some((x) => x.appliedDueId)) {
    const inst = await tx.installmentSchedule.findUnique({ where: { groupId_installmentNo: { groupId: st.groupId, installmentNo: st.targetPeriodNo } } });
    if (inst) {
      const div = D.max(ZERO, dec(inst.dividendAmount).minus(dec(st.dividendPerShare)));
      await tx.installmentSchedule.update({ where: { id: inst.id }, data: { dividendAmount: div.toFixed(2), netDueAmount: dec(inst.scheduledAmount).minus(div).toFixed(2) } });
    }
  }
  if (payout) await tx.payout.delete({ where: { id: payout.id } });
  if (st.auctionId) await tx.auctionSettlement.update({ where: { id: st.id }, data: { auctionId: null } });
  await tx.auctionSession.update({ where: { id: st.sessionId }, data: { status: 'CLOSED', resultAuctionId: null, rowVersion: { increment: 1 } } });
  if (st.auctionId) await tx.auction.delete({ where: { id: st.auctionId } });
  await tx.auctionSettlement.update({ where: { id: st.id }, data: { status: 'REVERSED', reversedAt: now, reversedById: userId, reversalReason: reason } });

  for (const type of ['AUCTION_SETTLED', 'DIVIDEND_APPLIED'] as const) {
    const orig = await tx.financialEvent.findUnique({ where: { companyId_idempotencyKey: { companyId: st.companyId, idempotencyKey: `${type}:${st.id}` } } });
    if (!orig) continue;
    await recordEvent(tx, {
      companyId: st.companyId,
      type: type === 'AUCTION_SETTLED' ? 'AUCTION_SETTLEMENT_REVERSED' : 'DIVIDEND_APPLIED_REVERSED',
      sourceType: 'AuctionSettlement',
      sourceId: st.id,
      idempotencyKey: `${type}_REVERSED:${st.id}`,
      occurredOn: istDate(now),
      amount: orig.amount.toFixed(2),
      payload: { reason },
      groupId: st.groupId,
      reversalOfEventId: orig.id,
    });
  }
  await tx.auditLog.create({ data: { companyId: st.companyId, userId, action: 'AUCTION_SETTLEMENT_REVERSED', entity: 'AuctionSettlement', entityId: st.id, details: JSON.stringify({ reason }) } });
  return tx.auctionSettlement.findUniqueOrThrow({ where: { id: st.id } });
}
