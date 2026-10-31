import { PrismaClient, Prisma } from '@prisma/client';
import { env } from './env.js';

/**
 * Money is stored as NUMERIC(15,2) (exact decimal) in PostgreSQL.
 *
 * Prisma returns NUMERIC columns as Prisma.Decimal objects. To keep the existing
 * API contract (JSON numbers) and controller code unchanged, these result
 * extensions convert each money field to a JS number when it is read. Values are
 * at most 2 decimal places, so the conversion is exact for display/transport;
 * arithmetic that must be exact should use src/lib/money.ts (integer paise).
 *
 * The test suite verifies DECIMAL_FIELDS covers every Decimal field in the schema.
 */
const num = (v: Prisma.Decimal | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

const decimalField = <K extends string>(field: K) => ({
  needs: { [field]: true } as { [P in K]: true },
  compute: (row: { [P in K]: Prisma.Decimal }) => num(row[field]),
});

export const DECIMAL_FIELDS: Record<string, readonly string[]> = {
  ChitGroup: ['chitValue', 'monthlyInstallment', 'foremanCommissionPct'],
  InstallmentSchedule: ['scheduledAmount', 'dividendAmount', 'netDueAmount'],
  PaymentTransaction: ['amount'],
  Auction: ['winningBidDiscount', 'foremanCommission', 'totalDividend', 'dividendPerMember'],
  AuctionBid: ['bidDiscount'],
  Payout: ['grossBidAmount', 'deductions', 'netPayoutAmount'],
  CashHandover: ['expectedCash', 'actualCash', 'difference'],
  Expense: ['amount'],
  Account: ['openingBalance', 'currentBalance'],
  JournalEntryLine: ['amount'],
  Refund: ['amount'],
  KhataCustomer: ['openingBalance'],
  KhataTransaction: ['amount'],
  AuctionDividendAllocation: ['amount'],
};

/**
 * Engine tables (P3+) keep money as exact Prisma.Decimal values end to end: engine code
 * converts them with the finance library and engine endpoints return them as decimal
 * strings. Every Decimal column must be either converted (DECIMAL_FIELDS) or belong to
 * one of these models — the schema test enforces it.
 */
export const ENGINE_DECIMAL_MODELS: readonly string[] = [
  'ContributionPeriod',
  'MemberDue',
  'PaymentAllocation',
  'PenaltyCharge',
  'FinancialAdjustment',
  'FinancialEvent',
];

function createClient() {
  return new PrismaClient({
    datasources: { db: { url: env.databaseUrl } },
  }).$extends({
    name: 'decimal-to-number',
    result: {
      chitGroup: {
        chitValue: decimalField('chitValue'),
        monthlyInstallment: decimalField('monthlyInstallment'),
        foremanCommissionPct: decimalField('foremanCommissionPct'),
      },
      installmentSchedule: {
        scheduledAmount: decimalField('scheduledAmount'),
        dividendAmount: decimalField('dividendAmount'),
        netDueAmount: decimalField('netDueAmount'),
      },
      paymentTransaction: { amount: decimalField('amount') },
      auction: {
        winningBidDiscount: decimalField('winningBidDiscount'),
        foremanCommission: decimalField('foremanCommission'),
        totalDividend: decimalField('totalDividend'),
        dividendPerMember: decimalField('dividendPerMember'),
      },
      auctionBid: { bidDiscount: decimalField('bidDiscount') },
      payout: {
        grossBidAmount: decimalField('grossBidAmount'),
        deductions: decimalField('deductions'),
        netPayoutAmount: decimalField('netPayoutAmount'),
      },
      cashHandover: {
        expectedCash: decimalField('expectedCash'),
        actualCash: decimalField('actualCash'),
        difference: decimalField('difference'),
      },
      expense: { amount: decimalField('amount') },
      account: {
        openingBalance: decimalField('openingBalance'),
        currentBalance: decimalField('currentBalance'),
      },
      journalEntryLine: { amount: decimalField('amount') },
      refund: { amount: decimalField('amount') },
      khataCustomer: { openingBalance: decimalField('openingBalance') },
      khataTransaction: { amount: decimalField('amount') },
      auctionDividendAllocation: { amount: decimalField('amount') },
    },
  });
}

export type AppPrismaClient = ReturnType<typeof createClient>;
export type AppTransactionClient = Parameters<Parameters<AppPrismaClient['$transaction']>[0]>[0];

const globalForPrisma = globalThis as unknown as { chitkartPrisma?: AppPrismaClient };

export const prisma: AppPrismaClient = globalForPrisma.chitkartPrisma ?? createClient();

if (!env.isProduction) {
  globalForPrisma.chitkartPrisma = prisma;
}
