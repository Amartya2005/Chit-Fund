import { describe, expect, it } from 'vitest';
import { linesFor, EventType } from '../../src/engine/accounting/postingRules.js';

const show = (t: EventType, p: Record<string, unknown>) => {
  const r = linesFor(t, p);
  if ('needsDecision' in r) return r.needsDecision;
  return r.lines.map((l) => `${l.side === 'DEBIT' ? 'Dr' : 'Cr'} ${l.role} ${l.amount.toFixed(2)}`);
};

describe('posting rules v1 (FINANCIAL_ENGINE §6.4)', () => {
  it('A-2 settlement: C 1,00,000 = G 85,000 + F 5,000 + credited 4,000 + unallocated 6,000', () => {
    expect(show('AUCTION_SETTLED', { chitValue: '100000', grossPrize: '85000', commission: '5000', dividendCredited: '4000', dividendUnallocated: '6000' })).toEqual([
      'Dr CHIT_POOL_PAYABLE 100000.00',
      'Cr PRIZE_PAYABLE 85000.00',
      'Cr COMMISSION_INCOME 5000.00',
      'Cr DIVIDEND_PAYABLE 4000.00',
      'Cr DIVIDEND_UNALLOCATED 6000.00',
    ]);
  });
  it('payments go to cash or bank by mode; advance kept separately; zero lines dropped', () => {
    expect(show('PAYMENT_RECEIVED', { total: '12000', toDues: '10000', advance: '2000', mode: 'CASH' })).toEqual(['Dr CASH 12000.00', 'Cr SUBSCRIBER_RECEIVABLE 10000.00', 'Cr SUBSCRIBER_ADVANCE 2000.00']);
    expect(show('PAYMENT_RECEIVED', { total: '500', toDues: '500', advance: '0', mode: 'UPI' })).toEqual(['Dr BANK 500.00', 'Cr SUBSCRIBER_RECEIVABLE 500.00']);
  });
  it('prize disbursement nets deductions against the receivable', () => {
    expect(show('PRIZE_DISBURSED', { gross: '85000', net: '76000', deductions: '9000', mode: 'BANK_TRANSFER' })).toEqual(['Dr PRIZE_PAYABLE 85000.00', 'Cr BANK 76000.00', 'Cr SUBSCRIBER_RECEIVABLE 9000.00']);
  });
  it('a waived contribution has no rule until its accounting treatment is decided', () => {
    expect(show('DUE_WAIVED', { amount: '100' })).toMatch(/^RULE_NEEDS_DECISION/);
  });
  it('unbalanced payloads are refused, never posted', () => {
    expect(() => linesFor('PAYMENT_RECEIVED', { total: '100', toDues: '90', advance: '0', mode: 'CASH' })).toThrow(/unbalanced/);
    expect(() => linesFor('AUCTION_SETTLED', { chitValue: '100', grossPrize: '50', commission: '10', dividendCredited: '10', dividendUnallocated: '0' })).toThrow(/unbalanced/);
  });
});
