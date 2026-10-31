# ChitKart — Infrastructure Stabilization Report (2026-10-31)

Status legend: **COMPLETED AND VERIFIED** · **IMPLEMENTED BUT NOT VERIFIED** · **PENDING** · **BLOCKED**

## Verification environment

* The cloud session's network policy blocks outbound connections to Supabase
  (`*.pooler.supabase.com`, `db.vulzvenuhsbdffhdvewd.supabase.co`, `vulzvenuhsbdffhdvewd.supabase.co` → proxy 403).
  Supabase was therefore managed through the Supabase management API (migrations, SQL checks, advisors),
  and the running application was verified against **local PostgreSQL 16** using the identical migrations.
* Schema parity Supabase ⇄ local was proven by fingerprints (md5 of all columns/types, indexes, constraints):
  identical — 27 tables, 46 foreign keys, 89 indexes, same 4 migrations recorded in `_prisma_migrations`.

## 1. Supabase integration
| Task | Status |
|---|---|
| Project `chit-fund-dev` (ref `vulzvenuhsbdffhdvewd`, ap-south-1) | COMPLETED AND VERIFIED |
| Version-controlled migrations created and applied (4) | COMPLETED AND VERIFIED |
| Tables / FKs / indexes / constraints identical to Prisma schema | COMPLETED AND VERIFIED (`prisma migrate diff --exit-code` = 0; fingerprints match) |
| RLS on every table (blocks Supabase REST API access) | COMPLETED AND VERIFIED (security advisor: only the expected INFO "RLS enabled, no policy") |
| Backend ⇄ Supabase live connection | BLOCKED (needs DB password in `backend/.env` and network access from where the API runs) |
| Supabase Storage for uploads | PENDING — photos are stored inline as validated base64 data URLs (existing behaviour); moving to Storage changes client + API contract and could not be exercised from this network |
| Seed super admin in Supabase | PENDING — run `npm run prisma:seed` with your own `SEED_SUPERADMIN_*` values |

## 2. Database reliability (migration `20261031000200`)
| Issue found | Fix | Status |
|---|---|---|
| Money stored as `DOUBLE PRECISION` | `NUMERIC(15,2)` (commission `NUMERIC(5,2)`); API still returns numbers; arithmetic in integer paise (`src/lib/money.ts`) | COMPLETED AND VERIFIED |
| Subscriber code, subscriber phone, group code, receipt no., idempotency key, journal no. globally unique → 2nd company could not create its first group/member | unique per company | COMPLETED AND VERIFIED (reproduced on original code) |
| `count()+1` numbering races / duplicates after deletes | atomic `CompanySequence` counters | COMPLETED AND VERIFIED (12 concurrent payments → 12 distinct receipts) |
| Ticket number `members.length+1` reused after removal | `max+1` (unique constraint remains) | COMPLETED AND VERIFIED |
| `Refund.groupId` without FK | FK added | COMPLETED AND VERIFIED |
| `User.email` not unique (login by email ambiguous) | unique | COMPLETED AND VERIFIED |
| Missing FK / filter indexes | 28 indexes added | COMPLETED AND VERIFIED |
| Group/staff/schedule creation not atomic | single transaction | COMPLETED AND VERIFIED |
| Conversion of existing float data | tested on pre-populated DB: values rounded to paise, no rows lost | COMPLETED AND VERIFIED |

## 3. Environment & configuration
| Task | Status |
|---|---|
| `backend/.env.example` documents every variable; `mobile/.env.example` (public vars only) | COMPLETED |
| Hard-coded DB URL/password, JWT secrets, Gmail SMTP passwords, personal email/phone removed from code | COMPLETED AND VERIFIED (startup fails without real config) |
| Validated config module (`src/config/env.ts`), no fallbacks | COMPLETED AND VERIFIED |
| CORS allow-list (`CORS_ORIGINS`) | COMPLETED AND VERIFIED |
| Mobile API URL via `EXPO_PUBLIC_API_URL` (was the original developer's production URL) | COMPLETED AND VERIFIED (web) |
| No secrets in web bundle | COMPLETED AND VERIFIED (bundle scanned) |
| `.env` files not committed | COMPLETED AND VERIFIED |
| Old credentials remain in git history | PENDING — rotate them (they belong to the original developer's Supabase/Gmail) / consider history rewrite |

## 4. Security remediation (all verified by automated attack tests)
* Removed 8 hard-coded "universal" passwords that logged into **any** account (and silently overwrote the real password).
* Removed public fallback JWT secrets; HS256 pinned; role/company always loaded from DB; session must exist.
* OTP: no longer returned in API responses or written to logs; stored as HMAC only (was plaintext in audit log visible to super admins); 5-attempt limit; 10-minute expiry; single use; no user enumeration; no fallback to a personal email address.
* Tenant isolation on every ID-based endpoint (groups, subscribers, ledgers, collections, approvals, reversals, receipts, auctions, payouts, refunds, handovers, journal entries, ledgers, users, khata staff, notifications). Cross-company access returns 404. Client-supplied `companyId` ignored for non-super-admins.
* Managers can no longer create/modify/suspend users in other companies or move users between companies; `updateUser` no longer returns `passwordHash`.
* Financial state machines: reversed transactions cannot be approved/re-reversed (atomic); payouts/refunds final once DISBURSED/REJECTED; deductions bounded; auction winner must be a group member; duplicate auction → 409.
* Input validation on payments, auctions, payouts, journal entries, expenses, groups, khata entries; upload validation (image MIME + file signature + size).
* Rate limiting (login, OTP request/verify, refresh, export, global); Helmet headers; JSON body limit 25 MB → 10 MB.
* Errors no longer leak Prisma/SQL details; data export redacts password hashes, refresh tokens and OTP records.
* Status: COMPLETED AND VERIFIED (tests below). On the **original** code the same tests fail: 14/31 auth tests and 13/19 tenant tests.

### Remaining concerns
* Account-creation and password-reset-by-admin emails still contain plaintext passwords (existing feature).
* Super admin role is platform-wide by design; super-admin "settings/plans/roles/backups/periods" live in memory and reset on restart (existing behaviour).
* Rate limits are in-memory (best-effort on Vercel serverless).
* Access tokens live 1 day and are stored in `sessionStorage` on web (XSS would expose them); no CSP on the web app.
* `getFinancialStatements` returns hard-coded sample balances (cash 74,500, bank 3,85,000…); bankbook splits balances 70/30 across fictional accounts; cashbook opening balance fixed at 50,000 — business logic not changed.
* Status/role fields are free-text strings (no DB enums/check constraints).
* A member can win more than one auction in the same group (no rule enforced; business decision).
* Audit logs are mutable by the DB owner (no append-only enforcement).

## 5–7. Verification results
| Check | Result |
|---|---|
| Backend `tsc --noEmit` | PASS |
| Backend ESLint | 0 errors, 10 warnings (pre-existing unused variables) |
| Backend build | PASS |
| Backend tests (Vitest, real PostgreSQL) | **98 passed / 0 failed** (6 files: auth 31, tenant isolation 19, workflows 32, rate-limit/CORS 6, money 8, schema 2) |
| Mobile `tsc --noEmit` | PASS |
| Mobile ESLint (new baseline) | 0 errors, 39 warnings (redundant regex escapes, unused vars) |
| Mobile web export (`expo export -p web`) | PASS (902 kB bundle) |
| Browser (Chromium) — super admin / manager / staff, desktop 1366px + mobile 390px, every tab | 0 console errors, 0 page errors, 0 failed API calls, no horizontal overflow |
| UI write flow (manager records a payment) | PASS (receipt `REC-2026-00004`, VERIFIED) |
| Vercel entry `api/index.js` loads | PASS |
| Docker image build / compose | BLOCKED (sandbox: Docker Hub rate limit, no Debian mirror access inside builds) |
| Native (Android/iOS) builds | PENDING (EAS project belongs to original developer) |

Existing-workflow coverage (all through the HTTP API, plus UI rendering): company creation, manager login,
staff creation/assignment, group creation, subscriber registration (manager + staff/KYC approval),
collection recording, payment verification, auction entry, payout management, refunds, accounting
(chart, journal, ledger, trial balance, expenses, cash/bank book, statements, reports), cash handover,
khata business/customer/ledger, dashboards, notifications, audit logs, export — **COMPLETED AND VERIFIED** (local PostgreSQL).

Pre-existing UI bug fixed: auction winner list showed `Ticket #:` without a number (`ticketNo` vs `ticketNumber`).

## 12. Deployment readiness
Development-ready against local PostgreSQL. Not production-ready until: Supabase credentials configured and
connectivity verified, leaked credentials rotated, own Expo/EAS project configured, production `CORS_ORIGINS`
and secrets set, Docker build verified on a normal network, Storage decision made.

## 13. Outstanding blockers
1. Supabase database password → `backend/.env` (`DATABASE_URL`, `DIRECT_URL`).
2. Network access from the API host to Supabase (this cloud environment blocks it).
3. Expo account / EAS project id, `EXPO_TOKEN`.
4. SMTP credentials (password reset emails).
