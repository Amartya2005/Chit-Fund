import { AppTransactionClient } from '../../config/prisma.js';
import { D } from '../../finance/decimal.js';
import { ENGINE_V1, dec, todayInIndia } from '../common.js';

/**
 * A ticket that leaves an engine group (surrender) stops owing instalments that fall due after
 * the exit date. Such future dues are removed only if nothing was paid, credited or charged on
 * them; anything else is kept (and reported) so no money disappears.
 */
export async function onTicketExited(tx: AppTransactionClient, groupId: string, subscriberId: string, userId: string) {
  const group = await tx.chitGroup.findUniqueOrThrow({ where: { id: groupId }, select: { engineVersion: true, companyId: true } });
  if (group.engineVersion !== ENGINE_V1) return null;
  const member = await tx.chitGroupMember.findUnique({ where: { groupId_subscriberId: { groupId, subscriberId } } });
  if (!member) return null;
  const today = todayInIndia();
  const future = await tx.memberDue.findMany({ where: { memberId: member.id, dueDate: { gt: today } }, include: { _count: { select: { allocations: true, penalties: true, adjustments: true } } } });
  const removable = future.filter(
    (d) => dec(d.paidAmount).isZero() && dec(d.dividendCredit).isZero() && d._count.allocations === 0 && d._count.penalties === 0 && d._count.adjustments === 0
  );
  const kept = future.filter((d) => !removable.includes(d));
  if (removable.length) await tx.memberDue.deleteMany({ where: { id: { in: removable.map((d) => d.id) } } });
  await tx.auditLog.create({
    data: {
      companyId: group.companyId,
      userId,
      action: 'ENGINE_TICKET_EXIT_DUES',
      entity: 'ChitGroupMember',
      entityId: member.id,
      details: JSON.stringify({
        removedFutureDues: removable.map((d) => ({ periodNo: d.periodNo, gross: d.grossAmount.toString() })),
        keptFutureDues: kept.map((d) => ({ periodNo: d.periodNo, reason: 'has payments, credits, penalties or adjustments' })),
        removedTotal: removable.reduce((s, d) => s.plus(dec(d.grossAmount)), new D(0)).toFixed(2),
      }),
    },
  });
  return { removed: removable.length, kept: kept.length };
}
