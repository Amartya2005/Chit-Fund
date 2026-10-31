import { Prisma } from '@prisma/client';
import { AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { D, Dec, ZERO, sum } from '../../finance/decimal.js';
import { computeContribution } from '../../finance/chit/contribution.js';
import { lockConfigSnapshot, resolveEffective } from '../../modules/financial-policies/policy.service.js';
import { Db, ENGINE_V1, dec, lockGroupRow, todayInIndia } from '../common.js';
import { allocateVerifiedPayment } from './dues.service.js';

/**
 * Convert a legacy group to the engine (decision D-32: explicit, previewed, per group).
 *
 * What is carried over, never recalculated:
 *  - contribution periods = the group's existing InstallmentSchedule (agreed amounts and dates);
 *  - one due per ACTIVE ticket per period; dividend credit = the schedule's dividendAmount
 *    (what the legacy workflow already credited);
 *  - every VERIFIED, non-reversed payment, applied to the instalment it was recorded for
 *    (legacy payments are tagged); anything above that due's outstanding becomes ADVANCE;
 *    payments of tickets that are no longer active are kept as LEGACY_EXITED_TICKET.
 * Blocking checks: missing/incomplete schedule; P0 dividend records that disagree with the
 * schedule; any reconciliation difference. Pending (unverified) payments are left alone and are
 * allocated by the engine when they are approved.
 */
export interface ConversionReport {
  groupId: string;
  asOf: string;
  periods: number;
  tickets: { active: number; notActive: number };
  contribution: { fromSchedule: string[]; policyRegularAmount: string | null; differsFromPolicy: boolean };
  payments: {
    verifiedCount: number;
    verifiedTotal: string;
    allocatedToDues: string;
    advance: string;
    exitedTickets: string;
    excludedPending: number;
    excludedRejectedOrReversed: number;
  };
  dividends: { creditedTotal: string; checkedAgainstAuctionRecords: number; legacyAuctionsWithoutDetail: number };
  pendingDividendDecisions: { count: number; total: string };
  auctionsHeld: number;
  blocking: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  reconciled: boolean;
}

interface Plan {
  report: ConversionReport;
  periods: { periodNo: number; dueDate: string; baseAmount: Dec; dividend: Dec }[];
  activeMembers: { id: string; subscriberId: string }[];
  payments: { id: string; subscriberId: string; installmentNo: number; amount: Dec; active: boolean }[];
}

async function plan(db: Db, group: { id: string; companyId: string; chitValue: number; totalMonths: number; maxMembers: number }): Promise<Plan> {
  const [schedule, members, payments, auctions, p0Credits, pending] = await Promise.all([
    db.installmentSchedule.findMany({ where: { groupId: group.id }, orderBy: { installmentNo: 'asc' } }),
    db.chitGroupMember.findMany({ where: { groupId: group.id }, select: { id: true, subscriberId: true, status: true } }),
    db.paymentTransaction.findMany({
      where: { groupId: group.id },
      select: { id: true, subscriberId: true, installmentNo: true, amount: true, verificationStatus: true, isReversed: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.auction.findMany({ where: { groupId: group.id }, select: { id: true, installmentNo: true } }),
    db.auctionDividendAllocation.findMany({ where: { auction: { groupId: group.id }, kind: 'TICKET_CREDIT' }, select: { auctionId: true, amount: true, targetInstallmentNo: true } }),
    db.auctionDividendAllocation.findMany({ where: { auction: { groupId: group.id }, status: 'PENDING_DECISION' }, select: { amount: true } }),
  ]);
  const blocking: ConversionReport['blocking'] = [];
  const warnings: ConversionReport['warnings'] = [];

  if (schedule.length === 0 || schedule.length !== group.totalMonths) {
    blocking.push({ code: 'SCHEDULE_INCOMPLETE', message: `The group has ${schedule.length} scheduled instalment(s) but ${group.totalMonths} months.` });
  }
  const periods = schedule.map((s) => ({ periodNo: s.installmentNo, dueDate: s.dueDate, baseAmount: dec(s.scheduledAmount), dividend: dec(s.dividendAmount) }));
  for (const p of periods) {
    if (p.dividend.greaterThan(p.baseAmount)) blocking.push({ code: 'DIVIDEND_ABOVE_INSTALMENT', message: `Instalment #${p.periodNo}: dividend ${p.dividend.toFixed(2)} exceeds the instalment ${p.baseAmount.toFixed(2)}.` });
  }

  // P0 auction records must agree with the dividend the schedule already credited.
  const byAuction = new Map<string, { amount: Dec; target: number | null }>();
  for (const a of p0Credits) byAuction.set(a.auctionId, { amount: dec(a.amount), target: a.targetInstallmentNo });
  let checked = 0;
  for (const [, c] of byAuction) {
    const p = periods.find((x) => x.periodNo === c.target);
    checked++;
    if (!p || !p.dividend.equals(c.amount)) {
      blocking.push({
        code: 'DIVIDEND_MISMATCH',
        message: `Auction records credit ${c.amount.toFixed(2)} per ticket to instalment #${c.target}, but the schedule shows ${p ? p.dividend.toFixed(2) : 'no such instalment'}.`,
      });
    }
  }
  const withoutDetail = auctions.filter((a) => !p0Credits.some((c) => c.auctionId === a.id)).length;
  if (withoutDetail) warnings.push({ code: 'LEGACY_AUCTION_WITHOUT_DETAIL', message: `${withoutDetail} auction(s) were recorded before per-ticket dividend records existed; their dividends are taken from the schedule.` });

  // contribution policy vs the agreed schedule (schedule wins; reported)
  const eff = await resolveEffective(db, group.companyId, group.id);
  let policyRegular: string | null = null;
  if (eff.policy) {
    policyRegular = computeContribution({ chitValue: new D(String(group.chitValue)).toFixed(2), periods: group.totalMonths }, eff.policy).regularAmount;
    const differs = periods.some((p) => !p.baseAmount.equals(policyRegular!));
    if (differs) warnings.push({ code: 'SCHEDULE_DIFFERS_FROM_POLICY', message: `The existing schedule is kept; it differs from the contribution the policy would calculate (${policyRegular}).` });
  }

  const memberStatus = new Map(members.map((mm) => [mm.subscriberId, mm.status]));
  const activeMembers = members.filter((mm) => mm.status === 'ACTIVE').map((mm) => ({ id: mm.id, subscriberId: mm.subscriberId }));
  const verified = payments.filter((p) => p.verificationStatus === 'VERIFIED' && !p.isReversed);
  const planned = verified.map((p) => ({ id: p.id, subscriberId: p.subscriberId, installmentNo: p.installmentNo, amount: dec(p.amount), active: memberStatus.get(p.subscriberId) === 'ACTIVE' }));

  // simulate tagged allocation to compute the report
  const paid = new Map<string, Dec>(); // subscriber:period → paid
  let toDues = ZERO;
  let advance = ZERO;
  let exited = ZERO;
  for (const p of planned) {
    if (!p.active) {
      exited = exited.plus(p.amount);
      continue;
    }
    const period = periods.find((x) => x.periodNo === p.installmentNo);
    if (!period) {
      advance = advance.plus(p.amount);
      warnings.push({ code: 'PAYMENT_FOR_UNKNOWN_INSTALMENT', message: `A payment of ${p.amount.toFixed(2)} was recorded for instalment #${p.installmentNo}, which is not scheduled; kept as advance.` });
      continue;
    }
    const key = `${p.subscriberId}:${p.installmentNo}`;
    const net = period.baseAmount.minus(period.dividend);
    const already = paid.get(key) ?? ZERO;
    const take = D.min(p.amount, D.max(ZERO, net.minus(already)));
    paid.set(key, already.plus(take));
    toDues = toDues.plus(take);
    advance = advance.plus(p.amount.minus(take));
  }
  const verifiedTotal = sum(planned.map((p) => p.amount));
  const reconciled = verifiedTotal.equals(toDues.plus(advance).plus(exited));
  if (!reconciled) blocking.push({ code: 'RECONCILIATION_FAILED', message: 'Verified payments do not equal allocated + advance + exited-ticket amounts.' });
  if (advance.greaterThan(0)) warnings.push({ code: 'ADVANCE_CREATED', message: `${advance.toFixed(2)} paid above the instalments it was recorded for is kept as advance (not moved to other instalments).` });

  const report: ConversionReport = {
    groupId: group.id,
    asOf: todayInIndia(),
    periods: periods.length,
    tickets: { active: activeMembers.length, notActive: members.length - activeMembers.length },
    contribution: { fromSchedule: [...new Set(periods.map((p) => p.baseAmount.toFixed(2)))], policyRegularAmount: policyRegular, differsFromPolicy: warnings.some((w) => w.code === 'SCHEDULE_DIFFERS_FROM_POLICY') },
    payments: {
      verifiedCount: planned.length,
      verifiedTotal: verifiedTotal.toFixed(2),
      allocatedToDues: toDues.toFixed(2),
      advance: advance.toFixed(2),
      exitedTickets: exited.toFixed(2),
      excludedPending: payments.filter((p) => p.verificationStatus === 'PENDING_VERIFICATION' && !p.isReversed).length,
      excludedRejectedOrReversed: payments.filter((p) => p.isReversed || p.verificationStatus === 'REJECTED' || p.verificationStatus === 'REVERSED').length,
    },
    dividends: {
      creditedTotal: sum(periods.map((p) => p.dividend.times(activeMembers.length))).toFixed(2),
      checkedAgainstAuctionRecords: checked,
      legacyAuctionsWithoutDetail: withoutDetail,
    },
    pendingDividendDecisions: { count: pending.length, total: sum(pending.map((p) => dec(p.amount))).toFixed(2) },
    auctionsHeld: auctions.length,
    blocking,
    warnings,
    reconciled,
  };
  return { report, periods, activeMembers, payments: planned };
}

export async function previewConversion(db: Db, group: Parameters<typeof plan>[1]) {
  return (await plan(db, group)).report;
}

export async function executeConversion(tx: AppTransactionClient, groupId: string, userId: string) {
  await lockGroupRow(tx, groupId);
  const group = await tx.chitGroup.findUniqueOrThrow({ where: { id: groupId } });
  if (group.engineVersion === ENGINE_V1) throw new HttpError(409, 'This group already uses the engine.', 'ALREADY_CONVERTED');
  const company = await tx.company.findUniqueOrThrow({ where: { id: group.companyId }, select: { engineEnabled: true } });
  if (!company.engineEnabled) throw new HttpError(409, 'The engine is not enabled for this company (super admin setting).', 'ENGINE_NOT_ENABLED');
  const p = await plan(tx, group as any);
  if (p.report.blocking.length) throw new HttpError(422, p.report.blocking[0].message, 'CONVERSION_BLOCKED', { report: p.report });

  // freeze the configuration the group starts with (refuses if incomplete / violating)
  const { snapshot } = await lockConfigSnapshot(tx, { companyId: group.companyId, subjectType: 'GROUP_ACTIVATION', subjectId: group.id, groupId: group.id, lockedById: userId });

  for (const period of p.periods) {
    const row = await tx.contributionPeriod.create({
      data: { companyId: group.companyId, groupId: group.id, periodNo: period.periodNo, dueDate: period.dueDate, baseAmount: period.baseAmount.toFixed(2) },
    });
    if (p.activeMembers.length) {
      await tx.memberDue.createMany({
        data: p.activeMembers.map((mm) => ({
          companyId: group.companyId,
          groupId: group.id,
          periodId: row.id,
          periodNo: period.periodNo,
          memberId: mm.id,
          subscriberId: mm.subscriberId,
          dueDate: period.dueDate,
          grossAmount: period.baseAmount.toFixed(2),
          dividendCredit: period.dividend.toFixed(2),
        })),
      });
    }
  }
  for (const pay of p.payments) {
    if (!pay.active) {
      await tx.paymentAllocation.create({ data: { companyId: group.companyId, paymentId: pay.id, dueId: null, bucket: 'LEGACY_EXITED_TICKET', amount: pay.amount.toFixed(2) } });
      continue;
    }
    await allocateVerifiedPayment(
      tx,
      { id: pay.id, companyId: group.companyId, groupId: group.id, subscriberId: pay.subscriberId, installmentNo: pay.installmentNo, amount: pay.amount.toFixed(2) as unknown as Prisma.Decimal },
      'TAGGED_PERIOD'
    );
  }
  // verify the database matches the plan exactly
  const agg = await tx.paymentAllocation.groupBy({ by: ['bucket'], where: { payment: { groupId: group.id }, reversedAt: null }, _sum: { amount: true } });
  const got = (b: string) => dec(agg.find((a) => a.bucket === b)?._sum.amount ?? 0).toFixed(2);
  if (got('DUE') !== p.report.payments.allocatedToDues || got('ADVANCE') !== p.report.payments.advance || got('LEGACY_EXITED_TICKET') !== p.report.payments.exitedTickets) {
    throw new HttpError(500, 'Conversion verification failed; nothing was changed.', 'CONVERSION_VERIFICATION_FAILED');
  }

  await tx.chitGroup.update({ where: { id: group.id }, data: { engineVersion: ENGINE_V1 } });
  const conversion = await tx.engineConversion.create({
    data: { companyId: group.companyId, groupId: group.id, snapshotId: snapshot.id, report: p.report as unknown as Prisma.InputJsonValue, convertedById: userId },
  });
  await tx.auditLog.create({
    data: { companyId: group.companyId, userId, action: 'ENGINE_GROUP_CONVERTED', entity: 'ChitGroup', entityId: group.id, details: JSON.stringify({ snapshotId: snapshot.id, report: p.report }) },
  });
  return { conversion, report: p.report, snapshotHash: snapshot.hash };
}
