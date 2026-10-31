import { Prisma } from '@prisma/client';
import { AppTransactionClient } from '../../config/prisma.js';
import { nextSequence, maxNumericSuffix } from '../../lib/sequence.js';
import { D } from '../../finance/decimal.js';
import { Db, dec, todayInIndia } from '../common.js';
import { EventType, POSTING_RULES_VERSION, RuleLine, linesFor } from './postingRules.js';

export interface EventInput {
  companyId: string;
  type: EventType;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  occurredOn: string;
  amount: string;
  payload: Record<string, unknown>;
  groupId?: string | null;
  subscriberId?: string | null;
  reversalOfEventId?: string | null;
}

/** Business date (IST) of an instant. */
export const istDate = (d: Date) => todayInIndia(d);

/**
 * Record a financial event (idempotent on companyId + idempotencyKey) and try to post it.
 * Must run inside the transaction of the domain change it describes.
 */
export async function recordEvent(tx: AppTransactionClient, e: EventInput) {
  await tx.financialEvent.createMany({
    data: [
      {
        companyId: e.companyId,
        type: e.type,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        idempotencyKey: e.idempotencyKey,
        occurredOn: e.occurredOn,
        amount: e.amount,
        payload: e.payload as Prisma.InputJsonValue,
        groupId: e.groupId ?? null,
        subscriberId: e.subscriberId ?? null,
        reversalOfEventId: e.reversalOfEventId ?? null,
        rulesVersion: POSTING_RULES_VERSION,
      },
    ],
    skipDuplicates: true,
  });
  const ev = await tx.financialEvent.findUniqueOrThrow({ where: { companyId_idempotencyKey: { companyId: e.companyId, idempotencyKey: e.idempotencyKey } } });
  if (ev.postingStatus === 'NOT_POSTED') await tryPost(tx, ev.id);
  return tx.financialEvent.findUniqueOrThrow({ where: { id: ev.id } });
}

/** Group posting starts at max(company cut-over, group conversion date): earlier history is covered by opening balances. */
async function postingStart(tx: Db, companyId: string, groupId: string | null): Promise<string | null> {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { ledgerCutoverDate: true } });
  if (!company.ledgerCutoverDate) return null;
  if (!groupId) return company.ledgerCutoverDate;
  const conv = await tx.engineConversion.findUnique({ where: { groupId }, select: { convertedAt: true } });
  const start = conv ? istDate(conv.convertedAt) : company.ledgerCutoverDate;
  return start > company.ledgerCutoverDate ? start : company.ledgerCutoverDate;
}

async function setNotPosted(tx: AppTransactionClient, id: string, reason: string) {
  await tx.financialEvent.update({ where: { id }, data: { notPostedReason: reason } });
  return reason;
}

/** Attempt to post one NOT_POSTED event. Returns 'POSTED' or the reason it stays unposted. */
export async function tryPost(tx: AppTransactionClient, eventId: string): Promise<string> {
  await tx.$queryRaw`SELECT "id" FROM "FinancialEvent" WHERE "id" = ${eventId} FOR UPDATE`;
  const ev = await tx.financialEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (ev.postingStatus === 'POSTED') return 'POSTED';
  const start = await postingStart(tx, ev.companyId, ev.groupId);
  if (!start) return setNotPosted(tx, ev.id, 'NO_LEDGER_CUTOVER');
  if (ev.occurredOn < start) return setNotPosted(tx, ev.id, `BEFORE_POSTING_START:${start}`);

  // lines: by rule, or the mirror image of the reversed event's journal
  let lines: (RuleLine & { accountId?: string })[];
  let reversalOfEntryId: string | null = null;
  if (ev.reversalOfEventId) {
    const orig = await tx.financialEvent.findUniqueOrThrow({ where: { id: ev.reversalOfEventId }, include: { journalEntry: { include: { lines: true } } } });
    if (orig.postingStatus !== 'POSTED' || !orig.journalEntry) return setNotPosted(tx, ev.id, 'ORIGINAL_NOT_POSTED');
    reversalOfEntryId = orig.journalEntry.id;
    lines = orig.journalEntry.lines.map((l) => ({ role: 'CASH', accountId: l.accountId, side: l.type === 'DEBIT' ? 'CREDIT' : 'DEBIT', amount: dec(l.amount) }));
  } else {
    const r = linesFor(ev.type as EventType, ev.payload as Record<string, any>);
    if ('needsDecision' in r) return setNotPosted(tx, ev.id, r.needsDecision);
    lines = r.lines;
    if (!lines.length) {
      // nothing to post (all amounts zero): mark posted without a journal
      await tx.financialEvent.update({ where: { id: ev.id }, data: { postingStatus: 'POSTED', postedAt: new Date(), notPostedReason: null } });
      return 'POSTED';
    }
    const roles = [...new Set(lines.map((l) => l.role))];
    const mapping = await tx.accountMapping.findMany({ where: { companyId: ev.companyId, role: { in: roles } } });
    const missing = roles.filter((r) => !mapping.some((mm) => mm.role === r));
    if (missing.length) return setNotPosted(tx, ev.id, `MAPPING_MISSING:${missing.join(',')}`);
    lines = lines.map((l) => ({ ...l, accountId: mapping.find((mm) => mm.role === l.role)!.accountId }));
  }
  const closed = await tx.financialPeriod.findFirst({ where: { companyId: ev.companyId, status: 'CLOSED', startDate: { lte: ev.occurredOn }, endDate: { gte: ev.occurredOn } } });
  if (closed) return setNotPosted(tx, ev.id, `PERIOD_CLOSED:${closed.name}`);

  const seq = await nextSequence(
    ev.companyId,
    'journalEntry',
    async () => maxNumericSuffix((await tx.journalEntry.findMany({ where: { companyId: ev.companyId, entryNo: { startsWith: 'JV-' } }, select: { entryNo: true } })).map((e) => e.entryNo), 'JV-'),
    tx
  );
  await tx.journalEntry.create({
    data: {
      companyId: ev.companyId,
      entryNo: `JV-${String(seq).padStart(6, '0')}`,
      date: ev.occurredOn,
      narration: `Auto: ${ev.type.replace(/_/g, ' ').toLowerCase()} (${ev.sourceType} ${ev.sourceId.slice(0, 8)})`,
      isBalanced: true,
      status: 'POSTED',
      sourceEventId: ev.id,
      reversalOfId: reversalOfEntryId,
      lines: {
        create: lines.map((l) => ({ accountId: l.accountId!, type: l.side, amount: l.amount.toFixed(2), description: ev.type, groupId: ev.groupId, subscriberId: ev.subscriberId })),
      },
    },
  });
  for (const l of lines) {
    await tx.account.update({ where: { id: l.accountId! }, data: { currentBalance: { increment: (l.side === 'DEBIT' ? l.amount : l.amount.negated()).toFixed(2) } } });
  }
  await tx.financialEvent.update({ where: { id: ev.id }, data: { postingStatus: 'POSTED', postedAt: new Date(), notPostedReason: null } });
  return 'POSTED';
}

/** Retry every unposted event of a company (oldest first, so reversals follow their originals). */
export async function repostCompany(tx: AppTransactionClient, companyId: string) {
  const pending = await tx.financialEvent.findMany({ where: { companyId, postingStatus: 'NOT_POSTED' }, orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
  const out: Record<string, number> = {};
  for (const p of pending) {
    const r = (await tryPost(tx, p.id)).split(':')[0];
    out[r] = (out[r] ?? 0) + 1;
  }
  return { attempted: pending.length, results: out };
}

/** Raise DUE_RAISED for every contribution period of the company due on or before asOf. */
export async function raiseDuePeriods(tx: AppTransactionClient, companyId: string, asOf: string) {
  const periods = await tx.contributionPeriod.findMany({
    where: { companyId, dueDate: { lte: asOf } },
    select: { id: true, groupId: true, periodNo: true, dueDate: true, dues: { select: { grossAmount: true } } },
  });
  const existing = new Set((await tx.financialEvent.findMany({ where: { companyId, type: 'DUE_RAISED' }, select: { sourceId: true } })).map((e) => e.sourceId));
  let raised = 0;
  for (const p of periods) {
    if (existing.has(p.id)) continue;
    const gross = p.dues.reduce((s, d) => s.plus(dec(d.grossAmount)), new D(0));
    await recordEvent(tx, {
      companyId,
      type: 'DUE_RAISED',
      sourceType: 'ContributionPeriod',
      sourceId: p.id,
      idempotencyKey: `DUE_RAISED:${p.id}`,
      occurredOn: p.dueDate,
      amount: gross.toFixed(2),
      payload: { gross: gross.toFixed(2), periodNo: p.periodNo, tickets: p.dues.length },
      groupId: p.groupId,
    });
    raised++;
  }
  return raised;
}
