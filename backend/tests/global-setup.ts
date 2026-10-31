import { execSync } from 'node:child_process';

export default function setup() {
  const url = process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:54329/chitkart_test';
  if (/supabase\.(co|com)/.test(url)) {
    throw new Error('Refusing to run destructive tests against a Supabase database. Use a local/disposable TEST_DATABASE_URL.');
  }
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
