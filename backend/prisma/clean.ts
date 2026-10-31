import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedSuperAdmin } from './seed.js';

/**
 * DESTRUCTIVE: deletes ALL application data, then seeds the super admin from
 * SEED_SUPERADMIN_* variables. Development use only.
 *
 * Refuses to run when NODE_ENV=production and requires CONFIRM_DB_CLEAN=yes.
 */
const prisma = new PrismaClient();

async function clean() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to wipe the database with NODE_ENV=production.');
  }
  if (process.env.CONFIRM_DB_CLEAN !== 'yes') {
    throw new Error('This deletes ALL data. Re-run with CONFIRM_DB_CLEAN=yes to proceed.');
  }

  console.log('Cleaning all tables from database...');
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length > 0) {
    const list = tables.map((t) => `"public"."${t.tablename.replace(/"/g, '""')}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
  }

  await seedSuperAdmin(prisma);
  console.log('Database reset complete.');
}

clean()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
