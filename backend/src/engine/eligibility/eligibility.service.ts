import { Prisma } from '@prisma/client';
import { AppTransactionClient } from '../../config/prisma.js';
import { HttpError } from '../../lib/http.js';
import { canonicalize, sha256 } from '../../finance/canonical.js';
import { ResolvedValues } from '../../modules/financial-policies/resolver.js';
import { todayInIndia } from '../common.js';
import { canOverride, evaluateTicket } from './rules.js';
import { groupTicketFacts, rulesFromValues } from './facts.service.js';

type Tx = AppTransactionClient;

/** Evaluate and store every ticket's eligibility for a session (at open, or on demand). */
export async function recordEligibility(tx: Tx, session: { id: string; companyId: string; groupId: string }, values: ResolvedValues, userId: string | null) {
  const rules = rulesFromValues(values.eligibility);
  const configHash = sha256(canonicalize(values.eligibility));
  const facts = await groupTicketFacts(tx, session.groupId, todayInIndia());
  const out = facts.map((f) => evaluateTicket(f, rules));
  await tx.eligibilityDecision.createMany({
    data: out.map((e) => ({ companyId: session.companyId, sessionId: session.id, memberId: e.memberId, eligible: e.eligible, results: e.results as unknown as Prisma.InputJsonValue, configHash, overriddenRules: [] })),
  });
  void userId;
  return out;
}

/**
 * Override failing rules for one ticket in one session (manager, with reason). Only rules listed in
 * ELIGIBILITY.overridableRules can be overridden; ACTIVE_TICKET and MAX_WINS never.
 */
export async function overrideEligibility(tx: Tx, session: { id: string; companyId: string; groupId: string; status: string }, values: ResolvedValues, memberId: string, reason: string, userId: string) {
  if (!['SCHEDULED', 'OPEN', 'CLOSED'].includes(session.status)) throw new HttpError(409, `Eligibility cannot be overridden for an auction that is ${session.status}.`, 'INVALID_STATE');
  const rules = rulesFromValues(values.eligibility);
  const facts = (await groupTicketFacts(tx, session.groupId, todayInIndia())).find((f) => f.memberId === memberId);
  if (!facts) throw new HttpError(404, 'Ticket not found in this group', 'NOT_FOUND');
  const e = evaluateTicket(facts, rules);
  if (e.eligible) throw new HttpError(409, 'The ticket is already eligible; nothing to override.', 'NOTHING_TO_OVERRIDE');
  if (!canOverride(e)) {
    const blocked = e.results.filter((r) => !r.passed && !r.overridable).map((r) => r.rule);
    throw new HttpError(403, `These rules cannot be overridden: ${blocked.join(', ')}.`, 'NOT_OVERRIDABLE', { eligibility: e });
  }
  const failing = e.results.filter((r) => !r.passed).map((r) => r.rule);
  const row = await tx.eligibilityDecision.create({
    data: {
      companyId: session.companyId,
      sessionId: session.id,
      memberId,
      eligible: true,
      results: e.results as unknown as Prisma.InputJsonValue,
      configHash: sha256(canonicalize(values.eligibility)),
      overriddenById: userId,
      overriddenRules: failing,
      overrideReason: reason,
    },
  });
  await tx.auditLog.create({ data: { companyId: session.companyId, userId, action: 'ELIGIBILITY_OVERRIDDEN', entity: 'AuctionSession', entityId: session.id, details: JSON.stringify({ memberId, failing, reason }) } });
  return row;
}
