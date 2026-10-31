import { prisma, AppPrismaClient, AppTransactionClient } from '../config/prisma.js';

type Db = AppPrismaClient | AppTransactionClient;

/**
 * Atomically allocate the next number in a per-company sequence.
 *
 * Replaces the previous `count() + 1` pattern, which produced duplicate receipt
 * numbers / subscriber codes under concurrent requests and after deletions.
 *
 * `seed` is used only the first time a sequence is created for a company, so that
 * companies with existing data continue numbering after their current highest value.
 * A single INSERT ... ON CONFLICT DO UPDATE is atomic in PostgreSQL, so concurrent
 * callers always receive distinct values.
 */
export async function nextSequence(
  companyId: string,
  key: string,
  seed: () => Promise<number>,
  db: Db = prisma
): Promise<number> {
  const existing = await db.companySequence.findUnique({ where: { companyId_key: { companyId, key } } });
  const initial = existing ? 0 : await seed();
  const rows = await db.$queryRaw<{ value: number }[]>`
    INSERT INTO "CompanySequence" ("companyId", "key", "value", "updatedAt")
    VALUES (${companyId}, ${key}, ${initial + 1}, NOW())
    ON CONFLICT ("companyId", "key")
    DO UPDATE SET "value" = "CompanySequence"."value" + 1, "updatedAt" = NOW()
    RETURNING "value"`;
  return Number(rows[0].value);
}

/** Highest numeric suffix among existing codes, e.g. ["SUB-1003","SUB-1010"] with prefix "SUB-" -> 1010. */
export function maxNumericSuffix(codes: (string | null | undefined)[], prefix: string): number {
  let max = 0;
  for (const code of codes) {
    if (!code || !code.startsWith(prefix)) continue;
    const n = Number(code.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}
