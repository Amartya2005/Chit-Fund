/**
 * Test environment. Integration tests need a DISPOSABLE PostgreSQL database:
 * set TEST_DATABASE_URL (default: local postgres on 54329, database chitkart_test).
 * The database is migrated with `prisma migrate deploy` and TRUNCATED between test files.
 * Never point this at Supabase or any database holding real data.
 */
const testDb = process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:54329/chitkart_test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDb;
process.env.DIRECT_URL = testDb;
process.env.JWT_SECRET = 'test_jwt_secret_0123456789abcdef0123456789abcdef';
process.env.REFRESH_TOKEN_SECRET = 'test_refresh_secret_0123456789abcdef0123456789ab';
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED || 'false';
process.env.CORS_ORIGINS = 'http://localhost:8081';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
