import { D, Dec } from '../../finance/decimal.js';

/**
 * Posting rules v1 (FINANCIAL_ENGINE §6.4). Structural proposal — the accounting treatment must be
 * confirmed by a chartered accountant (L-12) before a company relies on it; a company opts in by
 * setting a ledger cut-over date and mapping every role to one of its accounts.
 */
export const POSTING_RULES_VERSION = 'posting-rules-1';

export const ACCOUNT_ROLES = [
  'CASH',
  'BANK',
  'SUBSCRIBER_RECEIVABLE',
  'SUBSCRIBER_ADVANCE',
  'CHIT_POOL_PAYABLE',
  'PRIZE_PAYABLE',
  'COMMISSION_INCOME',
  'DIVIDEND_PAYABLE',
  'DIVIDEND_UNALLOCATED',
  'PENALTY_INCOME',
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** Suggested existing accounts (standard chart codes). Shown to the user, never applied automatically. */
export const SUGGESTED_ACCOUNT_CODES: Partial<Record<AccountRole, string>> = {
  CASH: '1001',
  BANK: '1002',
  SUBSCRIBER_RECEIVABLE: '1100',
  SUBSCRIBER_ADVANCE: '2002',
  PRIZE_PAYABLE: '2001',
  COMMISSION_INCOME: '4001',
  PENALTY_INCOME: '4002',
};

export type EventType =
  | 'DUE_RAISED'
  | 'PAYMENT_RECEIVED'
  | 'PAYMENT_REVERSED'
  | 'AUCTION_SETTLED'
  | 'AUCTION_SETTLEMENT_REVERSED'
  | 'DIVIDEND_APPLIED'
  | 'DIVIDEND_APPLIED_REVERSED'
  | 'PRIZE_DISBURSED'
  | 'PENALTY_CHARGED'
  | 'PENALTY_WAIVED'
  | 'DUE_WAIVED';

export interface RuleLine {
  role: AccountRole;
  side: 'DEBIT' | 'CREDIT';
  amount: Dec;
}

export type RuleResult = { lines: RuleLine[] } | { needsDecision: string };

const cashOrBank = (mode: unknown): AccountRole => (mode === 'CASH' ? 'CASH' : 'BANK');

export function linesFor(type: EventType, p: Record<string, any>): RuleResult {
  const a = (k: string) => new D(p[k] ?? 0);
  const L = (role: AccountRole, side: RuleLine['side'], amount: Dec): RuleLine => ({ role, side, amount });
  let lines: RuleLine[];
  switch (type) {
    case 'DUE_RAISED':
      lines = [L('SUBSCRIBER_RECEIVABLE', 'DEBIT', a('gross')), L('CHIT_POOL_PAYABLE', 'CREDIT', a('gross'))];
      break;
    case 'PAYMENT_RECEIVED':
      lines = [L(cashOrBank(p.mode), 'DEBIT', a('total')), L('SUBSCRIBER_RECEIVABLE', 'CREDIT', a('toDues')), L('SUBSCRIBER_ADVANCE', 'CREDIT', a('advance'))];
      break;
    case 'AUCTION_SETTLED':
      lines = [
        L('CHIT_POOL_PAYABLE', 'DEBIT', a('chitValue')),
        L('PRIZE_PAYABLE', 'CREDIT', a('grossPrize')),
        L('COMMISSION_INCOME', 'CREDIT', a('commission')),
        L('DIVIDEND_PAYABLE', 'CREDIT', a('dividendCredited')),
        L('DIVIDEND_UNALLOCATED', 'CREDIT', a('dividendUnallocated')),
      ];
      break;
    case 'DIVIDEND_APPLIED':
      lines = [L('DIVIDEND_PAYABLE', 'DEBIT', a('amount')), L('SUBSCRIBER_RECEIVABLE', 'CREDIT', a('amount'))];
      break;
    case 'PRIZE_DISBURSED':
      lines = [L('PRIZE_PAYABLE', 'DEBIT', a('gross')), L(cashOrBank(p.mode), 'CREDIT', a('net')), L('SUBSCRIBER_RECEIVABLE', 'CREDIT', a('deductions'))];
      break;
    case 'PENALTY_CHARGED':
      lines = [L('SUBSCRIBER_RECEIVABLE', 'DEBIT', a('amount')), L('PENALTY_INCOME', 'CREDIT', a('amount'))];
      break;
    case 'PENALTY_WAIVED':
      lines = [L('PENALTY_INCOME', 'DEBIT', a('amount')), L('SUBSCRIBER_RECEIVABLE', 'CREDIT', a('amount'))];
      break;
    case 'DUE_WAIVED':
      // Who bears a waived contribution (the foreman, the group pool, a loss) is not decided.
      return { needsDecision: 'RULE_NEEDS_DECISION: accounting treatment of a contribution waiver (L-12)' };
    default:
      // *_REVERSED events mirror the journal of the event they reverse (handled by the poster).
      return { needsDecision: `NO_RULE:${type}` };
  }
  lines = lines.filter((l) => l.amount.greaterThan(0));
  const dr = lines.filter((l) => l.side === 'DEBIT').reduce((s, l) => s.plus(l.amount), new D(0));
  const cr = lines.filter((l) => l.side === 'CREDIT').reduce((s, l) => s.plus(l.amount), new D(0));
  if (!dr.equals(cr)) throw new Error(`posting rule for ${type} is unbalanced (${dr.toFixed(2)} vs ${cr.toFixed(2)})`);
  return { lines };
}
