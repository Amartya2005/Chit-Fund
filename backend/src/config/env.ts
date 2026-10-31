import 'dotenv/config';

/**
 * Centralised, validated backend configuration.
 *
 * There are deliberately NO fallback secrets or fallback database URLs here:
 * a missing required variable stops the process at startup instead of silently
 * connecting to someone else's database or signing tokens with a public secret.
 * See backend/.env.example for documentation of every variable.
 */

const NODE_ENV = process.env.NODE_ENV || 'development';
const isTest = NODE_ENV === 'test';
const isProduction = NODE_ENV === 'production';

const missing: string[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    missing.push(name);
    return '';
  }
  return value.trim();
}

function optional(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

const databaseUrl = required('DATABASE_URL');
const jwtSecret = required('JWT_SECRET');
const refreshTokenSecret = required('REFRESH_TOKEN_SECRET');

if (missing.length > 0) {
  throw new Error(
    `[config] Missing required environment variable(s): ${missing.join(', ')}. ` +
      'Copy backend/.env.example to backend/.env and fill in real values.'
  );
}

if (/REPLACE_WITH|\[YOUR-PASSWORD\]/.test(databaseUrl)) {
  throw new Error('[config] DATABASE_URL still contains a placeholder. Paste the real connection string into backend/.env.');
}

for (const [name, value] of [
  ['JWT_SECRET', jwtSecret],
  ['REFRESH_TOKEN_SECRET', refreshTokenSecret],
] as const) {
  if (value.length < 32) {
    throw new Error(`[config] ${name} must be at least 32 characters (generate one with: openssl rand -hex 32).`);
  }
}
if (jwtSecret === refreshTokenSecret) {
  throw new Error('[config] JWT_SECRET and REFRESH_TOKEN_SECRET must be different.');
}

const corsOrigins = optional('CORS_ORIGINS', isProduction ? '' : 'http://localhost:8081,http://localhost:19006,http://localhost:5000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (isProduction && corsOrigins.includes('*')) {
  throw new Error('[config] CORS_ORIGINS must list explicit origins in production ("*" is not allowed with credentials).');
}

const smtpUser = optional('SMTP_USER');
const smtpPass = optional('SMTP_PASS').replace(/\s+/g, '');

export const env = {
  nodeEnv: NODE_ENV,
  isTest,
  isProduction,
  port: Number(optional('PORT', '5000')),
  databaseUrl,
  jwtSecret,
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '1d'),
  refreshTokenSecret,
  refreshTokenExpiresIn: optional('REFRESH_TOKEN_EXPIRES_IN', '7d'),
  corsOrigins,
  /** Number of reverse proxies in front of the API (Vercel/Render = 1). Used for correct client IPs in rate limiting. */
  trustProxy: Number(optional('TRUST_PROXY', isProduction ? '1' : '0')),
  portalUrl: optional('PORTAL_URL', 'http://localhost:8081'),
  smtp: {
    enabled: Boolean(smtpUser && smtpPass),
    user: smtpUser,
    pass: smtpPass,
    host: optional('SMTP_HOST', smtpUser.endsWith('@gmail.com') ? 'smtp.gmail.com' : ''),
    port: Number(optional('SMTP_PORT', '465')),
    secure: optional('SMTP_SECURE', 'true') !== 'false',
    from: optional('SMTP_FROM', smtpUser ? `"ChitKart Platform" <${smtpUser}>` : ''),
  },
  /** Maximum accepted size (bytes) of a base64 image (receipt photo / bill photo). */
  maxUploadBytes: Number(optional('MAX_UPLOAD_BYTES', String(5 * 1024 * 1024))),
  rateLimit: {
    enabled: optional('RATE_LIMIT_ENABLED', isTest ? 'false' : 'true') !== 'false',
  },
  /**
   * Shared secret for the external scheduler (cron) calling POST /engine/scheduler/run with the
   * X-Cron-Secret header. Empty = the endpoint is available only to signed-in managers (own company).
   */
  cronSecret: optional('CRON_SECRET'),
};
if (env.cronSecret && env.cronSecret.length < 32) {
  throw new Error('[config] CRON_SECRET must be at least 32 characters.');
}
