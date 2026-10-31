import { D, Dec } from '../../finance/decimal.js';

/**
 * Winner eligibility (pure). Rules come from the ELIGIBILITY policy; every rule is explicit
 * (UNLIMITED / NOT_CHECKED / false are choices, not defaults).
 *   ACTIVE_TICKET  ticket must be ACTIVE                         — never overridable
 *   MAX_WINS       prior wins < maxWinsPerTicket                  — never overridable (D-04 / L-03)
 *   MAX_OVERDUE    overdue dues ≤ maxOverdueAmount                — overridable if listed
 *   KYC            subscriber KYC VERIFIED when required          — overridable if listed
 */
export type RuleName = 'ACTIVE_TICKET' | 'MAX_WINS' | 'MAX_OVERDUE' | 'KYC';

export interface EligibilityRules {
  maxWinsPerTicket: number | 'UNLIMITED';
  maxOverdueAmount: string | 'NOT_CHECKED';
  requireKycVerified: boolean;
  overridableRules: ('MAX_OVERDUE' | 'KYC')[];
}

export interface TicketFacts {
  memberId: string;
  ticketNumber: number;
  status: string;
  wins: number;
  overdue: Dec;
  kycStatus: string;
}

export interface RuleResult {
  rule: RuleName;
  passed: boolean;
  overridable: boolean;
  message: string;
  inputs: Record<string, unknown>;
}

export interface TicketEligibility {
  memberId: string;
  ticketNumber: number;
  eligible: boolean;
  results: RuleResult[];
}

export function evaluateTicket(t: TicketFacts, r: EligibilityRules): TicketEligibility {
  const results: RuleResult[] = [];
  results.push({
    rule: 'ACTIVE_TICKET',
    passed: t.status === 'ACTIVE',
    overridable: false,
    message: t.status === 'ACTIVE' ? 'Ticket is active.' : `Ticket is ${t.status.toLowerCase()}.`,
    inputs: { status: t.status },
  });
  if (r.maxWinsPerTicket !== 'UNLIMITED') {
    results.push({
      rule: 'MAX_WINS',
      passed: t.wins < r.maxWinsPerTicket,
      overridable: false,
      message: t.wins < r.maxWinsPerTicket ? `Won ${t.wins} of ${r.maxWinsPerTicket} allowed time(s).` : `Already won ${t.wins} time(s); the limit is ${r.maxWinsPerTicket}.`,
      inputs: { wins: t.wins, max: r.maxWinsPerTicket },
    });
  }
  if (r.maxOverdueAmount !== 'NOT_CHECKED') {
    const ok = t.overdue.lessThanOrEqualTo(r.maxOverdueAmount);
    results.push({
      rule: 'MAX_OVERDUE',
      passed: ok,
      overridable: r.overridableRules.includes('MAX_OVERDUE'),
      message: ok ? `Overdue ₹${t.overdue.toFixed(2)} is within the limit ₹${new D(r.maxOverdueAmount).toFixed(2)}.` : `Overdue ₹${t.overdue.toFixed(2)} exceeds the limit ₹${new D(r.maxOverdueAmount).toFixed(2)}.`,
      inputs: { overdue: t.overdue.toFixed(2), limit: new D(r.maxOverdueAmount).toFixed(2) },
    });
  }
  if (r.requireKycVerified) {
    const ok = t.kycStatus === 'VERIFIED';
    results.push({ rule: 'KYC', passed: ok, overridable: r.overridableRules.includes('KYC'), message: ok ? 'KYC verified.' : `KYC is ${t.kycStatus.toLowerCase()}.`, inputs: { kycStatus: t.kycStatus } });
  }
  return { memberId: t.memberId, ticketNumber: t.ticketNumber, eligible: results.every((x) => x.passed), results };
}

/** An override may clear failing rules only when every failing rule is overridable. */
export const canOverride = (e: TicketEligibility) => !e.eligible && e.results.filter((x) => !x.passed).every((x) => x.overridable);
