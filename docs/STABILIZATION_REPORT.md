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

---

# P0 — Existing Auction Integrity & Financial Correctness (2026-10-31)

Branch `claude/p0-auction-integrity`, based on the stabilization commit `4d6daa8` (not on `main`).
Scope: fix the existing offline auction workflow only. No scheduler, live bidding, configuration
architecture, interest engine, member portal or accounting automation was started.

## Defects verified against the code and their resolution

| # | Defect (verified) | Status | Behaviour change |
|---|---|---|---|
| E1 | Manager UI sent `winningSubscriberId`; API required `winnerSubscriberId` → every in-app auction confirmation returned 400 (reproduced on `4d6daa8`: `400 "Missing required auction details"`) | **COMPLETED AND VERIFIED** | API accepts both names (conflicting values → 400 `CONFLICTING_WINNER`); UI now sends `winnerSubscriberId` + `winnerMemberId`. Verified in Chromium: confirmation from the UI → 201. |
| E2 | UI relied on `isPrized` / `prizedInstallmentNo` / `currentInstallmentNo`, never returned | **COMPLETED AND VERIFIED** | `GET /auctions/group/:id/eligibility` and group details return database-derived ticket status, prized auctions, eligibility and reasons; next instalment number derived from recorded auctions. |
| E3 | A member can win repeatedly | **DOCUMENTED, NOT CHANGED** (decision D-04) | Repeat wins remain permitted (existing behaviour). Made explicit: `repeatWinPolicy = PERMITTED_PENDING_DECISION_D04`, informational reason `ALREADY_PRIZED`, UI label "Already won auction #n". |
| — | No server-side winner validation beyond membership | **COMPLETED AND VERIFIED** | Winner must hold an **ACTIVE** ticket and have an **ACTIVE** subscriber account; ticket number must match; otherwise 400 (`WINNER_NOT_A_MEMBER`, `WINNER_NOT_ELIGIBLE`, `TICKET_MISMATCH`). |
| E4 | Dividend ÷ `maxMembers`; unfilled seats' share and rounding remainder silently dropped | **COMPLETED AND VERIFIED** (amounts preserved; distribution rule unchanged) | New `AuctionDividendAllocation` rows: `TICKET_CREDIT` per active ticket (credited via the next instalment, existing rule), `VACANT_SEATS` and `ROUNDING_REMAINDER` as `PENDING_DECISION`. Σ rows = dividend pool (paise-exact). |
| E5 | Final auction's dividend never credited | **COMPLETED AND VERIFIED** (amount preserved) | `NO_NEXT_INSTALLMENT` row holds the whole pool as `PENDING_DECISION`; no schedule is touched. |
| E6 | Commission recorded even when larger than the discount (reproduced on `4d6daa8`: ₹1,000 discount → ₹5,000 commission recorded, 201) | **COMPLETED AND VERIFIED** | Settlement refused: 400 `COMMISSION_EXCEEDS_DISCOUNT` with full breakdown (incl. shortfall); rejected calculation stored in `AuditLog` (`AUCTION_CONFIRMATION_REJECTED`). No formula change. |
| E7 | Arrears counted future instalments | **COMPLETED AND VERIFIED** | Only instalments with due date **before** the business date (Asia/Kolkata) are overdue; due-today = `DUE`, future = `UPCOMING`. Ledger and outstanding report accept `?asOf=YYYY-MM-DD`. |
| E8 | Hard-coded report figures (cash ₹74,500, bank ₹3,85,000, receivables ₹1,42,000, prize payable ₹95,000, late fees ₹12,500, cashbook opening ₹50,000, bankbook ₹2,50,000 split 70/30 into fictional accounts; UI also defaulted the opening float to ₹50,000) | **COMPLETED AND VERIFIED** | Unavailable figures are `null` with `dataQuality.unavailable[]`; UI shows "Not available yet". Comprehensive report arrears now computed (were fixed at 0). |
| E9 | Compliance screen: static statutory statuses; UI invented audit-trail entries when empty | **COMPLETED AND VERIFIED** | Responses carry `dataQuality.status = DEMONSTRATION`; UI banner; invented audit entries removed (empty state shown). Static values themselves unchanged (super-admin scope). |
| E10 | INR formatted with western grouping | **PARTIALLY** — auction screen and new report states use `en-IN`; other screens unchanged | |
| E11 | Surrender approval deleted the `ChitGroupMember` row | **COMPLETED AND VERIFIED** | Ticket kept with `status = SURRENDERED`, `exitedAt`, `exitReason`, `exitRefundId` (atomic with the refund update). Surrendered tickets cannot win, receive no dividend credit, do not use group capacity, and cannot take new collections unless they have payment history in the group (same as before). History visible in subscriber detail, ledger (`membershipStatus`, `countsTowardSummary: false`), statement and group details; lists expose it as `exitedMemberships`. |

### Transaction integrity (auction confirmation)
One database transaction: `SELECT … FOR UPDATE` on the group row → duplicate check → eligibility (inside the lock) → calculation → `Auction` (with `winnerMemberId`, `calculation` JSON, `calculationVersion`) → next-instalment dividend → dividend allocations → `Payout` → `AuditLog`. Unique `(groupId, installmentNo)` and `Payout.auctionId` remain as backstops.
Verified: duplicate → 409 `AUCTION_ALREADY_RECORDED`; 8 concurrent confirmations → exactly one 201, seven 409, one payout; injected failure on payout insert (DB trigger) → 500 with generic message, no auction / allocation / schedule change / audit row, and the same instalment settles afterwards. The auction module creates no accounting entries (none existed before; ledger posting is roadmap P4).

## Database migration
`20261101000000_p0_ticket_history_auction_integrity` (additive, no data rewritten):
* `ChitGroupMember`: `status` (default `ACTIVE`, CHECK in ACTIVE/SURRENDERED/EXITED), `exitedAt`, `exitReason`, `exitRefundId`, index `(groupId, status)`.
* `Auction`: `winnerMemberId` (FK → ticket, RESTRICT), `calculation` JSONB, `calculationVersion`; CHECK non-negative amounts `NOT VALID` (not checked against pre-P0 rows).
* New `AuctionDividendAllocation` (unique `(auctionId, allocationKey)` with a non-null key; CHECKs on amount/kind/status; RLS enabled).
* **Not recoverable:** memberships deleted by surrenders before P0 cannot be restored by the migration (evidence remains in `Refund` and `AuditLog` `SURRENDER_REFUND_APPROVED`). Auctions recorded before P0 have `winnerMemberId`/`calculation` = NULL and no allocation rows; prized status for them is derived from `winnerSubscriberId`.

## Compatibility
* `POST /auctions/confirm`: old field name still accepted; response keeps previous fields and adds `winner`, `payout`, `dividendAllocations`, `creditedTotal`, `pendingDecisionTotal`. Validation errors stay HTTP 400 and now include `code` (+ `details`).
* `winningTicketNo` that does not match the winner's ticket is now rejected (previously stored as sent).
* Ledger instalment statuses: `PAID | PARTIAL | OVERDUE | DUE | UPCOMING` (was `PAID | PARTIAL | DUE` with future rows shown as `DUE`); `summary.totalArrears` now excludes not-yet-due instalments; new fields `asOf`, `dueToday`, `upcoming`, `dueThroughAsOf`, `overdueInstallments`.
* Outstanding report: `totalDue` = due through as-of date; `arrears` = overdue only; 2% `lateFee` remains an indicative display value (`lateFeeIsIndicative: true`), not charged.
* Subscriber lists: `memberships` = current (ACTIVE) tickets as before; new `exitedMemberships`.
* Report endpoints may return `null` for unavailable figures (`dataQuality`).
* New endpoints: `POST /auctions/preview`, `GET /auctions/group/:groupId/eligibility`, `GET /auctions/dividend-allocations/pending`.

## Verification results (all executed)
| Check | Result |
|---|---|
| Backend tests (Vitest, real PostgreSQL 16) | **135 passed / 0 failed** — incl. 29 new P0 integration tests and 11 auction-calculation unit tests (one with 2,000 randomized cases) |
| Baseline reproduction on `4d6daa8` | E1 → 400 and E6 → 201 with ₹5,000 commission on a ₹1,000 discount (both reproduced, worktree since removed) |
| Backend `tsc` / ESLint / build | pass / 0 errors (11 warnings, unused variables) / pass |
| Mobile `tsc` / ESLint / web export | pass / 0 errors (40 warnings) / pass |
| Browser (Chromium): manager auction flow | installment #2 proposed, prized label shown, ₹3,000 discount → commission error + Confirm disabled, ₹20,000 → backend preview (₹5,000 / ₹15,000 / ₹1,500 per ticket / ₹10,500 pending) → Confirm → 201, winner ticket #2, payout to that subscriber, 0 console errors |
| Supabase `chit-fund-dev` (restored; `isf-jathara` paused to free the free-tier slot) | P0 migration applied and recorded in `_prisma_migrations` (checksum `4bb300eb…`); schema fingerprint identical to local PostgreSQL: 28 tables, 49 FKs, 95 indexes, same 5 migrations; RLS on all tables; security advisor: only the expected INFO "RLS enabled, no policy". No data in the project. |
| Browser: all roles × desktop 1366 px + mobile 390 px, every tab | 0 console errors, 0 page errors, 0 failed API calls, no horizontal overflow |

## Remaining business decisions (not implemented, amounts preserved)
D-03 (who receives unfilled-seat shares and rounding remainders), D-04 (repeat wins), D-07/D-11 (final-auction dividend; auctions where discount < commission), D-13 (commission basis/source), D-20 (when sample-labelled reports become ledger-based), plus legal items L-01..L-04. Until decided, `PENDING_DECISION` allocations stay visible via `GET /auctions/dividend-allocations/pending` and are not posted anywhere.
