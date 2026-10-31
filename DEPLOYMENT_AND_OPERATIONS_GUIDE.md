# ChitKart — Setup, Deployment & Operations Guide

This guide replaces the previous version, which contained credentials for the
original developer's infrastructure. **Those credentials (Supabase database
password, Gmail app passwords, JWT secrets) are still present in this
repository's git history and must be treated as compromised.** They do not
belong to this project and nothing in the code uses them any more.

## 1. Repository layout

| Path | What |
|---|---|
| `backend/` | Express + Prisma API (`/api/v1`), PostgreSQL (Supabase) |
| `backend/prisma/migrations/` | Version-controlled database migrations (source of truth) |
| `backend/tests/` | Vitest unit + integration tests (need a disposable PostgreSQL) |
| `mobile/` | Expo (React Native + web) app for super admin, managers and staff |
| `api/index.js` + `vercel.json` | Vercel deployment: web build + API as a serverless function |
| `Dockerfile`, `backend/Dockerfile`, `docker-compose.yml` | Container build / local Postgres + API |

## 2. Environment variables

### Backend (`backend/.env`, server-side secrets — never shipped to clients)

Copy `backend/.env.example` to `backend/.env`. Every variable is documented there.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Supabase **transaction pooler** (port 6543) + `?pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | yes for migrations | Supabase **session pooler / direct** (port 5432), used by `prisma migrate` |
| `JWT_SECRET`, `REFRESH_TOKEN_SECRET` | yes | two different values, ≥ 32 chars: `openssl rand -hex 32` |
| `CORS_ORIGINS` | production | comma-separated web origins; `*` is rejected in production |
| `NODE_ENV`, `PORT`, `TRUST_PROXY` | no | `TRUST_PROXY=1` behind Vercel / Render |
| `PORTAL_URL` | no | link used in emails |
| `SMTP_*`, `SUPPORT_EMAIL` | no | email is disabled when `SMTP_USER`/`SMTP_PASS` are empty |
| `MAX_UPLOAD_BYTES` | no | max receipt/bill photo size (default 5 MB) |
| `SEED_SUPERADMIN_*` | seeding only | first super admin account (`npm run prisma:seed`) |

The API **refuses to start** if a required variable is missing or still a placeholder.
There are no fallback secrets or fallback database URLs.

### Mobile / web (`mobile/.env`, public — compiled into the app)

| Variable | Notes |
|---|---|
| `EXPO_PUBLIC_API_URL` | API base URL incl. `/api/v1`. Empty = same origin (web on Vercel) or `http://localhost:5000/api/v1` locally. **Required for native builds.** |

Only `EXPO_PUBLIC_*` variables reach the app bundle. Never put secrets there.

### Environments

| | Database | API URL | Notes |
|---|---|---|---|
| development | Supabase `chit-fund-dev` (ref `vulzvenuhsbdffhdvewd`, ap-south-1) or local Postgres | `http://localhost:5000/api/v1` | `NODE_ENV=development` |
| staging | separate Supabase project (create when needed) | staging deployment URL | `NODE_ENV=production`, own secrets |
| production | separate Supabase project | production URL | `NODE_ENV=production`, own secrets, explicit `CORS_ORIGINS` |

Use different JWT secrets and database passwords per environment.

## 3. Database (Supabase) and migrations

Supabase project **chit-fund-dev** already has all migrations applied
(the `_prisma_migrations` table records them), RLS enabled on every table
(the Supabase REST API cannot read application data; the backend connects
as the table owner and is unaffected) and no data yet.

```bash
cd backend
npm ci
npx prisma generate
npm run migrate:status      # needs DATABASE_URL / DIRECT_URL in .env
npm run migrate:deploy      # apply pending migrations (non-destructive)
```

Creating a new migration after editing `prisma/schema.prisma` (against a
**development** database only):

```bash
npx prisma migrate dev --name describe_the_change
```

`prisma db push` is intentionally no longer used — it bypasses migration history.

Seed the first super admin (no default credentials exist):

```bash
SEED_SUPERADMIN_USERNAME=... SEED_SUPERADMIN_PASSWORD='...' \
SEED_SUPERADMIN_FULLNAME='...' SEED_SUPERADMIN_PHONE=... SEED_SUPERADMIN_EMAIL=... \
npm run prisma:seed
```

`npm run db:clean` wipes **all** data; it refuses to run with `NODE_ENV=production`
and requires `CONFIRM_DB_CLEAN=yes`.

## 4. Running locally

```bash
# API
cd backend && cp .env.example .env   # fill in DATABASE_URL, DIRECT_URL, JWT secrets
npm ci && npx prisma generate && npm run migrate:deploy
npm run dev                           # http://localhost:5000/api/v1/health

# App (web)
cd mobile && npm ci
npx expo start --web                  # http://localhost:8081 (talks to localhost:5000)

# Tests (disposable local PostgreSQL only — tables are TRUNCATED)
cd backend && TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/chitkart_test npm test
```

With Docker instead of a local Postgres: `docker compose up --build`
(PostgreSQL 16 + API; migrations run on start).

## 5. Deployment

### Vercel (web app + API)
* `vercel.json` builds the backend and the Expo web export; `/api/*` is served by `api/index.js`.
* Set the backend variables from section 2 in Vercel → Project → Settings → Environment Variables
  (`NODE_ENV=production`, `TRUST_PROXY=1`, `CORS_ORIGINS=https://<your-domain>`).
* Run `npm run migrate:deploy` (from `backend/`, with production `DIRECT_URL`) before deploying a release that adds migrations.
* Rate limits are in-memory per instance; on serverless they are best-effort.

### Render / any Docker host (API only)
* Root `Dockerfile` (or `backend/Dockerfile` with `backend/` as context).
* Start command: `npx prisma migrate deploy && node dist/server.js`.

### Mobile builds (EAS)
`mobile/app.json` still points to the original developer's Expo project
(`owner: akshyat2003`, `extra.eas.projectId`, `updates.url`). Before building
or publishing updates, run `npx eas init` with your own Expo account and
replace those values, set `EXPO_PUBLIC_API_URL` for each build profile, and add
an `EXPO_TOKEN` secret for `.github/workflows/eas-update.yml`.

## 6. CI

`.github/workflows/ci.yml` runs on every push / PR: migrations apply and match
the schema, backend typecheck + lint + tests (PostgreSQL service) + build,
mobile typecheck + lint + web export.
