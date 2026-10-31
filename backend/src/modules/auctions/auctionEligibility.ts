import { prisma, AppPrismaClient, AppTransactionClient } from '../../config/prisma.js';

type Db = AppPrismaClient | AppTransactionClient;

/**
 * Ticket eligibility for the EXISTING offline auction workflow, derived only from
 * database records (never from client-supplied flags).
 *
 * Blocking rules (the ticket cannot be selected as winner):
 *   MEMBERSHIP_SURRENDERED  ticket was surrendered (ChitGroupMember.status = SURRENDERED)
 *   MEMBERSHIP_EXITED       ticket ended for another reason (status = EXITED)
 *   SUBSCRIBER_INACTIVE     subscriber status is not ACTIVE (SUSPENDED / DEACTIVATED)
 *
 * Informational only (do NOT block — these are open business/legal decisions):
 *   ALREADY_PRIZED          ticket has already won an auction in this group. Repeat wins are
 *                           permitted by the current system; restricting them is decision D-04 / L-03.
 *   KYC_NOT_VERIFIED        subscriber KYC is not VERIFIED (never enforced for auctions before P0).
 */
export const REPEAT_WIN_POLICY = 'PERMITTED_PENDING_DECISION_D04' as const;

export interface EligibilityReason {
  code: string;
  blocking: boolean;
  message: string;
}

export interface TicketEligibility {
  memberId: string;
  ticketNumber: number;
  /** kept for backwards compatibility with existing UI code */
  ticketNo: number;
  subscriberId: string;
  subscriber: { id: string; fullName: string; subscriberCode: string; phone: string; status: string; kycStatus: string };
  membershipStatus: string;
  enrolledAt: Date;
  exitedAt: Date | null;
  exitReason: string | null;
  isPrized: boolean;
  prizedCount: number;
  prizedInstallmentNos: number[];
  prizedInstallmentNo: number | null;
  eligible: boolean;
  reasons: EligibilityReason[];
}

export interface GroupEligibility {
  groupId: string;
  maxMembers: number;
  totalMonths: number;
  activeTickets: number;
  vacantSeats: number;
  auctionsHeld: number;
  heldInstallmentNos: number[];
  nextInstallmentNo: number | null;
  repeatWinPolicy: typeof REPEAT_WIN_POLICY;
  tickets: TicketEligibility[];
}

export async function evaluateGroupEligibility(groupId: string, db: Db = prisma): Promise<GroupEligibility> {
  const group = await db.chitGroup.findUniqueOrThrow({
    where: { id: groupId },
    select: { id: true, maxMembers: true, totalMonths: true },
  });
  const [members, auctions] = await Promise.all([
    db.chitGroupMember.findMany({
      where: { groupId },
      include: {
        subscriber: { select: { id: true, fullName: true, subscriberCode: true, phone: true, status: true, kycStatus: true } },
      },
      orderBy: { ticketNumber: 'asc' },
    }),
    db.auction.findMany({
      where: { groupId },
      select: { installmentNo: true, winnerSubscriberId: true, winnerMemberId: true },
      orderBy: { installmentNo: 'asc' },
    }),
  ]);

  const tickets: TicketEligibility[] = members.map((m) => {
    // Auctions recorded before P0 have no winnerMemberId; a subscriber can hold only
    // one ticket per group (unique groupId+subscriberId), so the subscriber identifies the ticket.
    const wins = auctions.filter((a) => (a.winnerMemberId ? a.winnerMemberId === m.id : a.winnerSubscriberId === m.subscriberId));
    const reasons: EligibilityReason[] = [];
    if (m.status === 'SURRENDERED') {
      reasons.push({ code: 'MEMBERSHIP_SURRENDERED', blocking: true, message: `Ticket #${m.ticketNumber} was surrendered${m.exitedAt ? ` on ${m.exitedAt.toISOString().slice(0, 10)}` : ''}.` });
    } else if (m.status !== 'ACTIVE') {
      reasons.push({ code: 'MEMBERSHIP_EXITED', blocking: true, message: `Ticket #${m.ticketNumber} is no longer active (${m.status}).` });
    }
    if (m.subscriber.status !== 'ACTIVE') {
      reasons.push({ code: 'SUBSCRIBER_INACTIVE', blocking: true, message: `Subscriber account is ${m.subscriber.status.toLowerCase()}.` });
    }
    if (wins.length > 0) {
      reasons.push({
        code: 'ALREADY_PRIZED',
        blocking: false,
        message: `Already won auction #${wins.map((w) => w.installmentNo).join(', #')}. Repeat wins are currently permitted; the rule is pending business/legal decision D-04.`,
      });
    }
    if (m.subscriber.kycStatus !== 'VERIFIED') {
      reasons.push({ code: 'KYC_NOT_VERIFIED', blocking: false, message: `KYC status is ${m.subscriber.kycStatus} (not enforced for auctions).` });
    }
    const installmentNos = wins.map((w) => w.installmentNo);
    return {
      memberId: m.id,
      ticketNumber: m.ticketNumber,
      ticketNo: m.ticketNumber,
      subscriberId: m.subscriberId,
      subscriber: m.subscriber,
      membershipStatus: m.status,
      enrolledAt: m.enrolledAt,
      exitedAt: m.exitedAt,
      exitReason: m.exitReason,
      isPrized: wins.length > 0,
      prizedCount: wins.length,
      prizedInstallmentNos: installmentNos,
      prizedInstallmentNo: installmentNos.length ? installmentNos[installmentNos.length - 1] : null,
      eligible: !reasons.some((r) => r.blocking),
      reasons,
    };
  });

  const held = auctions.map((a) => a.installmentNo);
  const heldSet = new Set(held);
  let nextInstallmentNo: number | null = null;
  for (let k = 1; k <= group.totalMonths; k++) {
    if (!heldSet.has(k)) {
      nextInstallmentNo = k;
      break;
    }
  }
  const activeTickets = members.filter((m) => m.status === 'ACTIVE').length;

  return {
    groupId: group.id,
    maxMembers: group.maxMembers,
    totalMonths: group.totalMonths,
    activeTickets,
    vacantSeats: Math.max(0, group.maxMembers - activeTickets),
    auctionsHeld: auctions.length,
    heldInstallmentNos: held,
    nextInstallmentNo,
    repeatWinPolicy: REPEAT_WIN_POLICY,
    tickets,
  };
}
