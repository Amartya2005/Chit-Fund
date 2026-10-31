import { Dec, FinanceInputError, fmt, money, positiveInt, round } from '../decimal.js';
import { CalcStep, StepRecorder } from '../breakdown.js';
import { ChitPolicy, validatePolicy } from './policy.js';

export interface ContributionInput {
  chitValue: string | number;
  periods: number;
}

export interface ContributionResult {
  /** contribution per ticket for periods 1..periods-1 (and the last one unless LAST_PERIOD_ADJUSTS) */
  regularAmount: string;
  /** contribution per ticket in the final period */
  lastPeriodAmount: string;
  totalPerTicket: string;
  /** chitValue − totalPerTicket; positive = under-collection, negative = over-collection; 0 when the last period adjusts */
  differencePerTicket: string;
  breakdown: CalcStep[];
}

/** Base contribution per ticket per period (FINANCIAL_ENGINE §3.2; decision D-24 → policy.contribution). */
export function computeContribution(input: ContributionInput, policy: ChitPolicy): ContributionResult {
  validatePolicy(policy);
  const C = money(input.chitValue, 'chitValue');
  const P = positiveInt(input.periods, 'periods');
  if (C.isZero()) throw new FinanceInputError('chitValue', 'must be greater than 0');
  const steps = new StepRecorder();

  const raw = C.dividedBy(P);
  const mode = policy.contribution.rounding;
  const regular: Dec = mode === 'RUPEE_HALF_UP' ? round(raw, 'HALF_UP', 0) : round(raw, mode === 'PAISE_DOWN' ? 'DOWN' : 'HALF_UP', 2);
  steps.add('regularAmount', `chit value ÷ ${P} periods`, regular, { unrounded: raw, rounding: mode, inputs: { chitValue: C, periods: P } });
  if (regular.isZero()) throw new FinanceInputError('chitValue', 'contribution rounds to zero');

  let last = regular;
  if (policy.contribution.differenceHandling === 'LAST_PERIOD_ADJUSTS') {
    last = C.minus(regular.times(P - 1));
    if (!last.greaterThan(0)) throw new FinanceInputError('periods', 'last-period adjustment would not be positive');
    steps.add('lastPeriodAmount', `chit value − regular × ${P - 1}`, last);
  }
  const total = regular.times(P - 1).plus(last);
  const diff = C.minus(total);
  steps.add('differencePerTicket', 'chit value − total contributions per ticket', diff);

  return {
    regularAmount: fmt(regular),
    lastPeriodAmount: fmt(last),
    totalPerTicket: fmt(total),
    differencePerTicket: fmt(diff),
    breakdown: steps.steps,
  };
}

