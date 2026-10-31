import { AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { nextSequence } from '../../lib/sequence.js';
import { FinanceInputError } from '../../finance/decimal.js';
import { Frequency, HolidayPolicy, RecurrenceRule, istInstant, occurrences, validateRule, addDays } from '../../finance/schedule/recurrence.js';
import { Db, requireDecisions, todayInIndia } from '../common.js';

/** How far ahead sessions are materialised. */
export const HORIZON_DAYS = 60;

export interface ScheduleInput {
  frequency: Frequency;
  interval?: number;
  byWeekdays?: number[];
  byMonthDays?: number[];
  byWeekdayOrdinal?: number | null;
  explicitDates?: string[];
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  opensAtLocal: string;
  closesAtLocal: string;
  holidayPolicy: HolidayPolicy;
  weeklyOffDays?: number[];
}

export function parseScheduleInput(b: any): RecurrenceRule & { opensAtLocal: string; closesAtLocal: string } {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'A schedule is required', 'VALIDATION_FAILED');
  // no defaults for decisions: frequency, times and holiday policy must be given
  for (const f of ['frequency', 'startDate', 'opensAtLocal', 'closesAtLocal', 'holidayPolicy']) {
    if (b[f] === undefined || b[f] === null || b[f] === '') throw new HttpError(400, `${f} is required`, 'VALIDATION_FAILED');
  }
  const rule: RecurrenceRule = {
    frequency: b.frequency,
    interval: b.interval ?? 1,
    byWeekdays: b.byWeekdays ?? [],
    byMonthDays: b.byMonthDays ?? [],
    byWeekdayOrdinal: b.byWeekdayOrdinal ?? null,
    explicitDates: b.explicitDates ?? [],
    startDate: b.startDate,
    endDate: b.endDate ?? null,
    maxOccurrences: b.maxOccurrences ?? null,
    holidayPolicy: b.holidayPolicy,
    weeklyOffDays: b.weeklyOffDays ?? [],
  };
  try {
    validateRule(rule);
    istInstant(rule.startDate, b.opensAtLocal);
    istInstant(rule.startDate, b.closesAtLocal);
  } catch (e) {
    throw new HttpError(400, e instanceof FinanceInputError ? e.message : 'Invalid schedule', 'VALIDATION_FAILED');
  }
  if (b.closesAtLocal <= b.opensAtLocal) throw new HttpError(400, 'closesAtLocal must be later than opensAtLocal on the same day', 'VALIDATION_FAILED');
  return { ...rule, opensAtLocal: b.opensAtLocal, closesAtLocal: b.closesAtLocal };
}

export const ruleOf = (s: {
  frequency: string; interval: number; byWeekdays: number[]; byMonthDays: number[]; byWeekdayOrdinal: number | null; explicitDates: string[];
  startDate: string; endDate: string | null; maxOccurrences: number | null; holidayPolicy: string; weeklyOffDays: number[];
}): RecurrenceRule => ({ ...s, frequency: s.frequency as Frequency, holidayPolicy: s.holidayPolicy as HolidayPolicy });

async function holidaysOf(db: Db, companyId: string) {
  return (await db.holiday.findMany({ where: { companyId }, select: { date: true } })).map((h) => h.date);
}

/** Create AuctionSession rows for occurrences up to `until` (idempotent: unique scheduleId + occurrenceKey). */
export async function materializeSchedule(tx: AppTransactionClient, scheduleId: string, until: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`schedule:${scheduleId}`}, 0))`;
  const s = await tx.auctionSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
  if (s.status !== 'ACTIVE') return { created: 0 };
  const eff = await requireDecisions(tx, s.companyId, s.groupId, ['scheduling']);
  const occ = occurrences(ruleOf(s), until, await holidaysOf(tx, s.companyId));
  const existing = new Set((await tx.auctionSession.findMany({ where: { scheduleId }, select: { occurrenceKey: true } })).map((x) => x.occurrenceKey));
  let created = 0;
  for (const o of occ) {
    if (existing.has(o.key)) continue;
    const seq = await nextSequence(s.companyId, `auctionSession:${s.groupId}`, async () => (await tx.auctionSession.aggregate({ where: { groupId: s.groupId }, _max: { sequenceNo: true } }))._max.sequenceNo ?? 0, tx);
    await tx.auctionSession.create({
      data: {
        companyId: s.companyId,
        groupId: s.groupId,
        scheduleId: s.id,
        occurrenceKey: o.key,
        sequenceNo: seq,
        scheduledDate: o.date,
        opensAt: istInstant(o.date, s.opensAtLocal),
        closesAt: istInstant(o.date, s.closesAtLocal),
        mode: eff.values.scheduling.mode,
        ...(o.moved ? { statusReason: `moved from ${o.key} (holiday policy ${s.holidayPolicy})` } : {}),
      },
    });
    created++;
  }
  const last = occ.length ? occ[occ.length - 1].date : s.generatedUntil;
  await tx.auctionSchedule.update({ where: { id: s.id }, data: { generatedUntil: until > (last ?? '') ? until : last } });
  return { created };
}

export async function createSchedule(tx: AppTransactionClient, group: { id: string; companyId: string }, input: ReturnType<typeof parseScheduleInput>, userId: string) {
  await requireDecisions(tx, group.companyId, group.id, ['scheduling']);
  const s = await tx.auctionSchedule.create({
    data: {
      companyId: group.companyId,
      groupId: group.id,
      frequency: input.frequency,
      interval: input.interval,
      byWeekdays: input.byWeekdays,
      byMonthDays: input.byMonthDays,
      byWeekdayOrdinal: input.byWeekdayOrdinal,
      explicitDates: input.explicitDates,
      startDate: input.startDate,
      endDate: input.endDate,
      maxOccurrences: input.maxOccurrences,
      opensAtLocal: input.opensAtLocal,
      closesAtLocal: input.closesAtLocal,
      holidayPolicy: input.holidayPolicy,
      weeklyOffDays: input.weeklyOffDays,
      createdById: userId,
    },
  });
  // Planned count vs tickets that can still win (D-10 is open: reported, not enforced)
  const planned = occurrences(input, input.endDate ?? addDays(input.startDate, 3660), await holidaysOf(tx, group.companyId)).length;
  const [active, wins] = await Promise.all([
    tx.chitGroupMember.count({ where: { groupId: group.id, status: 'ACTIVE' } }),
    tx.auction.count({ where: { groupId: group.id } }),
  ]);
  const warnings = planned > Math.max(0, active - wins) ? [{ code: 'MORE_AUCTIONS_THAN_UNPRIZED_TICKETS', message: `${planned} auctions are planned but only ${Math.max(0, active - wins)} active tickets have not won yet (decision D-10).` }] : [];
  const mat = await materializeSchedule(tx, s.id, addDays(todayInIndia(), HORIZON_DAYS));
  await tx.auditLog.create({ data: { companyId: group.companyId, userId, action: 'AUCTION_SCHEDULE_CREATED', entity: 'AuctionSchedule', entityId: s.id, details: JSON.stringify({ input, planned, warnings }) } });
  return { schedule: s, planned, materialized: mat.created, warnings };
}
