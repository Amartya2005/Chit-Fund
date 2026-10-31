import { Prisma } from '@prisma/client';
import { AppTransactionClient, AppPrismaClient } from '../config/prisma.js';
import { HttpError } from '../lib/http.js';
import { D, Dec } from '../finance/decimal.js';
import { resolveEffective } from '../modules/financial-policies/policy.service.js';
import { ResolvedConfig } from '../modules/financial-policies/resolver.js';
import { resolveAsOf, todayInIndia } from '../modules/subscribers/arrears.js';

export type Db = AppPrismaClient | AppTransactionClient;
export const ENGINE_V1 = 'ENGINE_V1';
export { todayInIndia, resolveAsOf };

/** Exact decimal from a Prisma.Decimal / number / string. */
export const dec = (v: Prisma.Decimal | number | string | null | undefined): Dec => new D(v === null || v === undefined ? 0 : v.toString());
/** Money as a fixed 2-decimal string for API responses (exact). */
export const m = (v: Prisma.Decimal | Dec | number | string | null | undefined) => dec(v as any).toFixed(2);

export function requireEngineGroup(group: { engineVersion?: string | null; name?: string }) {
  if (group.engineVersion !== ENGINE_V1) {
    throw new HttpError(409, `Chit group ${group.name ?? ''} still uses the existing workflow; convert it to the engine first.`.replace('  ', ' '), 'NOT_ENGINE_GROUP');
  }
}

/** Row lock on the group: serialises dues/settlement changes for one group. */
export async function lockGroupRow(tx: AppTransactionClient, groupId: string) {
  await tx.$queryRaw`SELECT "id" FROM "ChitGroup" WHERE "id" = ${groupId} FOR UPDATE`;
}

/**
 * Effective configuration for an engine operation; refuses (422 CONFIG_INCOMPLETE) when any of the
 * decisions the operation depends on is still open. Never substitutes a default.
 */
export async function requireDecisions(db: Db, companyId: string, groupId: string, prefixes: string[]): Promise<ResolvedConfig> {
  const eff = await resolveEffective(db, companyId, groupId);
  const open = [...eff.missing, ...eff.missingLegalLimits].filter((p) => prefixes.some((x) => p === x || p.startsWith(`${x}.`)));
  if (open.length) {
    throw new HttpError(422, `These settings must be decided before this operation: ${open.join(', ')}.`, 'CONFIG_INCOMPLETE', { missing: open });
  }
  const blocking = eff.violations.filter((v) => prefixes.some((x) => v.path === x || v.path.startsWith(`${x}.`)));
  if (blocking.length) throw new HttpError(422, blocking[0].message, 'CONFIG_VIOLATION', { violations: blocking });
  return eff;
}

export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
