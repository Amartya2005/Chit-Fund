import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Creates (or leaves untouched) the platform's first SUPER_ADMIN account.
 *
 * No credentials are hard-coded. Provide them through environment variables:
 *   SEED_SUPERADMIN_USERNAME, SEED_SUPERADMIN_PASSWORD, SEED_SUPERADMIN_FULLNAME,
 *   SEED_SUPERADMIN_PHONE, SEED_SUPERADMIN_EMAIL (optional)
 * The password must satisfy the app's password policy.
 */
const prisma = new PrismaClient();

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is required to seed the super admin (see backend/.env.example).`);
  }
  return v.trim();
}

export async function seedSuperAdmin(client: PrismaClient = prisma) {
  const username = requiredEnv('SEED_SUPERADMIN_USERNAME');
  const password = requiredEnv('SEED_SUPERADMIN_PASSWORD');
  const fullName = requiredEnv('SEED_SUPERADMIN_FULLNAME');
  const phone = requiredEnv('SEED_SUPERADMIN_PHONE');
  const email = process.env.SEED_SUPERADMIN_EMAIL?.trim().toLowerCase() || null;

  const strong =
    password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
  if (!strong) {
    throw new Error('SEED_SUPERADMIN_PASSWORD must be 8+ characters with upper case, lower case, a number and a special character.');
  }

  const existing = await client.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`Seed: user "${username}" already exists; no changes made.`);
    return existing;
  }

  const user = await client.user.create({
    data: {
      role: 'SUPER_ADMIN',
      username,
      fullName,
      phone,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      status: 'ACTIVE',
    },
  });
  console.log(`Seed: super admin "${username}" created.`);
  return user;
}

const isDirectRun = process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  seedSuperAdmin()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
