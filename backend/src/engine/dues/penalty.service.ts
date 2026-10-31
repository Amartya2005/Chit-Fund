import { Prisma } from '@prisma/client';
import { AppTransactionClient } from '../../config/prisma.js';
import { D, round } from '../../finance/decimal.js';
import { addDays, dec, lockGroupRow, requireDecisions } from '../common.js';
import { contributionOutstanding } from './dues.service.js';
import { recordEvent } from '../accounting/events.service.js';

/**
 * Penalty run for one engine group (decision D-22 → PENALTY policy; L-10 legality unconfirmed).
 * A due is penalised once ("per missed period") when its dueDate + graceDays is before `asOf`
 * and contribution is still unpaid. Idempotent: PenaltyCharge.chargeKey = "<dueId>:<mode>".
 * Penalties are never charged on penalties.
 */
export async function runPenalties(tx: AppTransactionClient, group: { id: string; companyId: string }, asOf: string, userId: string) {
  const eff = await requireDecisions(tx, group.companyId, group.id, ['penalty']);
  const pen = eff.values.penalty as { mode: string; flatAmount?: string; percent?: string; graceDays?: number; maxPerPeriod?: string | null };
  if (pen.mode === 'NONE') return { mode: 'NONE', charged: [] as { dueId: string; periodNo: number; amount: string }[] };
  await lockGroupRow(tx, group.id);
  const dues = await tx.memberDue.findMany({ where: { groupId: group.id }, orderBy: [{ periodNo: 'asc' }, { memberId: 'asc' }] });
  const charged: { dueId: string; periodNo: number; amount: string }[] = [];
  for (const d of dues) {
    if (!(addDays(d.dueDate, pen.graceDays ?? 0) < asOf)) continue;
    const unpaid = contributionOutstanding(d);
    if (!unpaid.greaterThan(0)) continue;
    let amount = pen.mode === 'FLAT_PER_PERIOD' ? new D(pen.flatAmount!) : round(unpaid.times(pen.percent!).dividedBy(100), 'HALF_UP', 2);
    if (pen.maxPerPeriod) amount = D.min(amount, pen.maxPerPeriod);
    if (!amount.greaterThan(0)) continue;
    const chargeKey = `${d.id}:${pen.mode}`;
    const inserted = await tx.penaltyCharge.createMany({
      data: [{ companyId: group.companyId, dueId: d.id, chargeKey, amount: amount.toFixed(2), asOf, rule: { ...pen, unpaidContribution: unpaid.toFixed(2) } as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) continue;
    await tx.memberDue.update({ where: { id: d.id }, data: { penaltyAmount: { increment: amount.toFixed(2) } } });
    await recordEvent(tx, {
      companyId: group.companyId,
      type: 'PENALTY_CHARGED',
      sourceType: 'PenaltyCharge',
      sourceId: chargeKey,
      idempotencyKey: `PENALTY_CHARGED:${chargeKey}`,
      occurredOn: asOf,
      amount: amount.toFixed(2),
      payload: { amount: amount.toFixed(2), periodNo: d.periodNo, dueId: d.id },
      groupId: group.id,
      subscriberId: d.subscriberId,
    });
    charged.push({ dueId: d.id, periodNo: d.periodNo, amount: amount.toFixed(2) });
  }
  await tx.auditLog.create({
    data: { companyId: group.companyId, userId, action: 'ENGINE_PENALTY_RUN', entity: 'ChitGroup', entityId: group.id, details: JSON.stringify({ asOf, rule: pen, charged: charged.length, total: charged.reduce((s, c) => s.plus(c.amount), new D(0)).toFixed(2) }) },
  });
  return { mode: pen.mode, charged };
}

export const penaltyTotal = (rows: { amount: Prisma.Decimal }[]) => rows.reduce((s, r) => s.plus(dec(r.amount)), new D(0));
