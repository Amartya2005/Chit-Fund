import { AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { nextSequence } from '../../lib/sequence.js';
import { istInstant } from '../../finance/schedule/recurrence.js';
import { isDate, lockGroupRow, requireDecisions, requireEngineGroup } from '../common.js';
import { lockSession, sessionSnapshot, snapshotValues } from './settlement.service.js';
import { recordEligibility } from '../eligibility/eligibility.service.js';

type Tx = AppTransactionClient;
const audit = (tx: Tx, s: { companyId: string; id: string }, userId: string, action: string, details: unknown) =>
  tx.auditLog.create({ data: { companyId: s.companyId, userId, action, entity: 'AuctionSession', entityId: s.id, details: JSON.stringify(details) } });

function expect(status: string, allowed: string[], action: string) {
  if (!allowed.includes(status)) throw new HttpError(409, `Cannot ${action} an auction that is ${status}.`, 'INVALID_STATE');
}

export async function createAdhocSession(tx: Tx, group: { id: string; companyId: string; engineVersion: string; name: string }, b: any, userId: string) {
  requireEngineGroup(group);
  const eff = await requireDecisions(tx, group.companyId, group.id, ['scheduling']);
  if (!isDate(b?.date)) throw new HttpError(400, 'date (YYYY-MM-DD) is required', 'VALIDATION_FAILED');
  let opensAt: Date, closesAt: Date;
  try {
    opensAt = istInstant(b.date, b.opensAtLocal);
    closesAt = istInstant(b.date, b.closesAtLocal);
  } catch {
    throw new HttpError(400, 'opensAtLocal and closesAtLocal (HH:mm) are required', 'VALIDATION_FAILED');
  }
  if (closesAt <= opensAt) throw new HttpError(400, 'closesAtLocal must be later than opensAtLocal', 'VALIDATION_FAILED');
  const seq = await nextSequence(group.companyId, `auctionSession:${group.id}`, async () => (await tx.auctionSession.aggregate({ where: { groupId: group.id }, _max: { sequenceNo: true } }))._max.sequenceNo ?? 0, tx);
  const s = await tx.auctionSession.create({
    data: { companyId: group.companyId, groupId: group.id, sequenceNo: seq, scheduledDate: b.date, opensAt, closesAt, mode: eff.values.scheduling.mode, statusReason: typeof b.reason === 'string' ? b.reason.slice(0, 300) : 'ad-hoc auction' },
  });
  await audit(tx, s, userId, 'AUCTION_SESSION_CREATED', { date: b.date });
  return s;
}

export async function openSession(tx: Tx, id: string, userId: string) {
  const pre = await tx.auctionSession.findUniqueOrThrow({ where: { id } });
  await lockGroupRow(tx, pre.groupId);
  const s = await lockSession(tx, id);
  expect(s.status, ['SCHEDULED'], 'open');
  const eff = await requireDecisions(tx, s.companyId, s.groupId, ['scheduling']);
  let values = eff.values;
  if (eff.values.scheduling.lockPoint === 'AT_OPEN') values = snapshotValues(await sessionSnapshot(tx, s, userId)); // D-08
  await tx.auctionSession.update({ where: { id }, data: { status: 'OPEN', rowVersion: { increment: 1 } } });
  const eligibility = await recordEligibility(tx, s, values, userId);
  await audit(tx, s, userId, 'AUCTION_SESSION_OPENED', { lockPoint: eff.values.scheduling.lockPoint, eligible: eligibility.filter((e) => e.eligible).length, total: eligibility.length });
  return tx.auctionSession.findUniqueOrThrow({ where: { id } });
}

export async function closeSession(tx: Tx, id: string, userId: string) {
  const s = await lockSession(tx, id);
  expect(s.status, ['OPEN'], 'close');
  await tx.auctionSession.update({ where: { id }, data: { status: 'CLOSED', rowVersion: { increment: 1 } } });
  await audit(tx, s, userId, 'AUCTION_SESSION_CLOSED', {});
  return tx.auctionSession.findUniqueOrThrow({ where: { id } });
}

export async function postponeSession(tx: Tx, id: string, b: any, userId: string) {
  const s = await lockSession(tx, id);
  expect(s.status, ['SCHEDULED'], 'postpone');
  const reason = typeof b?.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 300) : null;
  if (!reason) throw new HttpError(400, 'A reason is required', 'VALIDATION_FAILED');
  if (!isDate(b?.date)) throw new HttpError(400, 'date (YYYY-MM-DD) is required', 'VALIDATION_FAILED');
  let opensAt: Date, closesAt: Date;
  try {
    opensAt = istInstant(b.date, b.opensAtLocal);
    closesAt = istInstant(b.date, b.closesAtLocal);
  } catch {
    throw new HttpError(400, 'opensAtLocal and closesAtLocal (HH:mm) are required', 'VALIDATION_FAILED');
  }
  if (closesAt <= opensAt) throw new HttpError(400, 'closesAtLocal must be later than opensAtLocal', 'VALIDATION_FAILED');
  if (b.expectedRowVersion !== undefined && b.expectedRowVersion !== s.rowVersion) throw new HttpError(409, 'The auction changed since you loaded it.', 'VERSION_CONFLICT');
  await tx.auctionSession.update({ where: { id }, data: { scheduledDate: b.date, opensAt, closesAt, statusReason: `postponed: ${reason}`, rowVersion: { increment: 1 } } });
  await audit(tx, s, userId, 'AUCTION_SESSION_POSTPONED', { from: { date: s.scheduledDate, opensAt: s.opensAt, closesAt: s.closesAt }, to: { date: b.date, opensAt, closesAt }, reason });
  return tx.auctionSession.findUniqueOrThrow({ where: { id } });
}

export async function cancelSession(tx: Tx, id: string, b: any, userId: string) {
  const s = await lockSession(tx, id);
  expect(s.status, ['SCHEDULED', 'OPEN', 'CLOSED'], 'cancel');
  const reason = typeof b?.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 300) : null;
  if (!reason) throw new HttpError(400, 'A reason is required', 'VALIDATION_FAILED');
  await tx.auctionSession.update({ where: { id }, data: { status: 'CANCELLED', statusReason: reason, rowVersion: { increment: 1 } } });
  await audit(tx, s, userId, 'AUCTION_SESSION_CANCELLED', { reason });
  return tx.auctionSession.findUniqueOrThrow({ where: { id } });
}

/** No bid was received (D-11): cancel the session or mark it carried forward, per policy. */
export async function noBidSession(tx: Tx, id: string, userId: string) {
  const s = await lockSession(tx, id);
  expect(s.status, ['OPEN', 'CLOSED'], 'record no bid for');
  const eff = await requireDecisions(tx, s.companyId, s.groupId, ['scheduling.noBidRule']);
  const rule = eff.values.scheduling.noBidRule as 'CANCEL_SESSION' | 'CARRY_FORWARD';
  await tx.auctionSession.update({
    where: { id },
    data: { status: rule === 'CANCEL_SESSION' ? 'CANCELLED' : 'NO_BID', statusReason: rule === 'CANCEL_SESSION' ? 'no bid (cancelled per policy)' : 'no bid (carried forward per policy)', rowVersion: { increment: 1 } },
  });
  await audit(tx, s, userId, 'AUCTION_SESSION_NO_BID', { rule });
  return tx.auctionSession.findUniqueOrThrow({ where: { id } });
}
