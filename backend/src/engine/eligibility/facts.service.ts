import { D } from '../../finance/decimal.js';
import { Db } from '../common.js';
import { dueViews } from '../dues/dues.service.js';
import { EligibilityRules, TicketFacts, evaluateTicket } from './rules.js';

/** Facts for every ticket of a group as of a business date (wins from settled auctions, overdue from engine dues). */
export async function groupTicketFacts(db: Db, groupId: string, asOf: string): Promise<TicketFacts[]> {
  const [members, auctions, dues] = await Promise.all([
    db.chitGroupMember.findMany({ where: { groupId }, include: { subscriber: { select: { kycStatus: true } } }, orderBy: { ticketNumber: 'asc' } }),
    db.auction.findMany({ where: { groupId }, select: { winnerMemberId: true, winnerSubscriberId: true } }),
    db.memberDue.findMany({ where: { groupId } }),
  ]);
  return members.map((mm) => {
    // legacy auctions recorded before P0 identify the winner by subscriber only
    const wins = auctions.filter((a) => a.winnerMemberId === mm.id || (!a.winnerMemberId && a.winnerSubscriberId === mm.subscriberId)).length;
    const own = dues.filter((d) => d.memberId === mm.id);
    const overdue = own.length ? new D(dueViews(own, asOf).totals.overdue) : new D(0);
    return { memberId: mm.id, ticketNumber: mm.ticketNumber, status: mm.status, wins, overdue, kycStatus: mm.subscriber.kycStatus };
  });
}

export const rulesFromValues = (v: Record<string, any>): EligibilityRules => ({
  maxWinsPerTicket: v.maxWinsPerTicket,
  maxOverdueAmount: v.maxOverdueAmount,
  requireKycVerified: v.requireKycVerified,
  overridableRules: v.overridableRules ?? [],
});

export async function evaluateGroup(db: Db, groupId: string, asOf: string, rules: EligibilityRules) {
  return (await groupTicketFacts(db, groupId, asOf)).map((f) => ({ facts: f, result: evaluateTicket(f, rules) }));
}
