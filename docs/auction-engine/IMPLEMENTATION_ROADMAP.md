# ChitKart 2.0 — Implementation Roadmap

Status: **DRAFT — nothing in this roadmap has started.** Implementation begins only after the decisions marked *blocking* in `OPEN_DECISIONS.md` are approved.

---

## 1. Guiding constraints
* Build on the stabilized baseline (`4d6daa8`): tenant helpers, `sendError`, money helpers, `CompanySequence`, migrations + CI drift check, 98 passing tests. **These tests must stay green in every phase.**
* Additive migrations only; existing groups remain on the legacy path until explicitly converted.
* Each phase ends with: migrations applied to a disposable DB + test DB + Supabase dev project, CI green, documented test results, demo on the dev environment.
* The live-bidding infrastructure is not required for offline auctions; it is scheduled late so the engine can deliver value without it.

## 2. Phases

| Phase | Scope | Depends on | Blocking decisions |
|---|---|---|---|
| **P0 Prerequisites** | Fix E1 (auction field name) and E2 (derive prized status from `Auction`); `en-IN` currency formatter (E10); add `decimal.js` direct dependency; persist company feature flags (`Company.engineEnabled`); choose hosting for realtime (D-33/D-34); merge `claude/compassionate-davinci-rdydxp` into `main` | — | D-33 (hosting) informational |
| **P1 Finance engine core (pure library)** | `src/finance/` decimal & rounding, breakdown recorder, Model A calculations (A1 default; A2 behind flag), golden tests for every worked example, property tests; **parity tests** proving A1 reproduces existing `calculateAuctionResult` outputs | P0 | D-03, D-13, D-24 |
| **P2 Configuration system** | M1 migration; policy versions, pointers, legal limit profile (super admin), resolver, snapshots + hash; config APIs; read-only "effective settings" UI | P1 | D-04, L-01, L-02 (limits must exist before activation) |
| **P3 Per-ticket dues & allocation** | M2 migration; `ContributionSchedule/Period`, `MemberDue`, `PaymentAllocation`; allocation waterfall; outstanding fixed (E7); penalties engine; legacy-group conversion tool (dry-run + reconciliation report) | P1, P2 | D-22, D-23, D-32 |
| **P4 Accounting posting** | M3 migration; `FinancialEvent`, `AccountMapping`, posting rules, cut-over + opening balances; ledger-based cashbook/bankbook/statements after cut-over; `dataSource` labelling before cut-over | P3 | D-19, D-20, L-12 (CA review of posting rules) |
| **P5 Scheduler & sessions (offline mode)** | M4 migration (sessions, schedules, exceptions, holidays, eligibility, calculation runs, settlements, dividends, commission, adjustments); materializer job + cron trigger; lifecycle APIs; offline result entry, preview, maker–checker, settlement, reversal; legacy `/auctions/confirm` routed through the engine for engine groups; manager UI (calendar, offline entry, approvals, group settings wizard) | P2, P3, P4 | D-06, D-07, D-08, D-10, D-11, D-14, D-15 |
| **P6 Eligibility engine** | rule evaluation + explanations + overrides; max-wins enforcement (E3) | P5 | D-04, D-05, L-03 |
| **P7 Member role & portal** | `MEMBER` role, onboarding/invite flow linking `Subscriber.userId`, member screens (read-only first) | P3, P5 | D-02, L-13 (KYC/DPDP) |
| **P8 Online bidding** | bid API, row-lock serialization, anti-sniping, realtime service (SSE/WS + `LISTEN/NOTIFY`), polling fallback, member auction room, manager live monitor; load test | P5, P6, P7 | D-12, D-16, D-17, D-33, L-05 |
| **P9 Interest engine (Model B)** | M5 migration; product policies, quotes, accounts, schedules, accruals (cumulative rounding), repayments, prepayment, rate changes, postings | P1, P2, P4 | **D-25, L-07, L-08, L-09 (legal gate — do not start without sign-off)** |
| **P10 Reporting & hardening** | replace remaining hard-coded statements; auction/dividend/commission reports; persisted financial periods with posting lock; performance tuning; security review; documentation | P4–P9 | D-20 |

Indicative sizing (single experienced full-stack developer, excluding decision lead time): P0 1 wk · P1 2 wk · P2 2 wk · P3 2–3 wk · P4 2 wk · P5 3–4 wk · P6 1 wk · P7 2 wk · P8 3 wk · P9 3–4 wk · P10 2 wk. Estimates are rough and must be revisited after P1.

Critical path for **offline configurable auctions with daily/weekly/monthly schedules**: P0 → P1 → P2 → P3 → P4 → P5 → P6.

## 3. Dependency graph
```
P0 ─▶ P1 ─▶ P2 ─▶ P3 ─▶ P4 ─▶ P5 ─▶ P6 ─▶ P8
                │            │            ▲
                │            └────▶ P7 ───┘
                └────────────▶ P9 (legal gate)      P10 after P4–P9
```

## 4. Testing strategy and milestones

### 4.1 Test layers
| Layer | Tooling | Location |
|---|---|---|
| Pure engine unit + golden tests | Vitest (existing) | `backend/tests/unit/finance/*` |
| Property / invariant tests | `fast-check` (new dev dependency, D-31) | `backend/tests/property/*` |
| Integration (HTTP + PostgreSQL) | Vitest + Supertest + disposable Postgres (existing harness `tests/helpers.ts`) | `backend/tests/integration/*` |
| Concurrency | parallel requests in integration tests; `pg` advisory-lock contention tests | same |
| Realtime | ws/SSE client in tests; reconnect simulation | `backend/tests/realtime/*` |
| UI smoke | Playwright (already used ad hoc) as a CI job against the web export | `e2e/` |
| Load (P8) | k6 or autocannon against staging | out of CI |

### 4.2 Financial tests (per phase)
* **P1:** every worked example in `FINANCIAL_ENGINE.md` as a golden test (A-1..A-4, B-0..B-7); rounding edge cases (x.xx5, negative adjustments, divisor 1, very large `C` up to `NUMERIC(15,2)` max); parity with existing formula on 10k random inputs; INV-A1..A3, INV-A7.
* **P3:** dues revision, partial/over-payment allocation, penalty after grace, penalty caps, waivers, INV-A4, INV-A5; outstanding excludes future periods (regression for E7).
* **P4:** each event → balanced entry (INV-G3), one-to-one event/entry (INV-G4), reversal nets to zero (INV-G5), cut-over excludes earlier history, trial balance balances after a full simulated group life (INV-A8).
* **P9:** simple/compound/flat/reducing schedules (B-1..B-6), daily vs monthly accrual equivalence via cumulative rounding (INV-B2), early/partial repayment (B-6, B-7), late payment penal interest (B-5), variable rate split (B-8), INV-B1..B5.

### 4.3 Auction tests
* Schedule generation: daily, selected weekdays, every n weeks, monthly by day (incl. 29–31 and month-end), monthly by n-th weekday, explicit dates, holidays (skip/next/previous), DST-free IST conversions, end date/count limits.
* Idempotency: materializer run twice, concurrently from two workers (two DB connections), after crash mid-run → zero duplicates (unique key violations swallowed, counts asserted).
* Lifecycle: postpone keeps `occurrenceKey`; cancel voids bids; settle twice → second is a no-op/409; reversal + re-settlement (revision 2).
* Bidding: 50 concurrent bids → strictly increasing sequence, single best bid, no lost updates; duplicate `clientRequestId` → identical response; bids after close (DB clock) rejected; anti-sniping extension bounds; sealed vs open visibility; ineligible bidder rejected; min/max/step validation.
* Eligibility: each rule pass/fail with explanation; overrides only on overridable rules; max wins (E3 regression).
* Winner selection: highest discount; tie rule (D-12); no-bid rule (D-11).

### 4.4 Security tests (extend the existing tenant-isolation suite)
* Cross-company: every new endpoint called with another company's IDs → 404 and no state change (same pattern as `tests/integration/tenant-isolation.test.ts`).
* Unauthorized configuration changes: staff/member → 403; manager editing `LEGAL_LIMITS` → 403; values above legal limits → 422.
* Unauthorized auction operations: member opening/closing/settling → 403; staff settling → 403; maker approving own submission → 403.
* Unauthorized financial adjustments: missing approval → not applied.
* Duplicate financial transactions: same `Idempotency-Key` → single effect; same `FinancialEvent.idempotencyKey` → single journal entry.
* Concurrent settlement: 10 parallel settle calls → exactly one settlement, one payout, one set of dividends, one journal entry.
* Member data scope: member A cannot read member B's dues/bids/eligibility.

### 4.5 Milestone gates
| Gate | Criteria |
|---|---|
| G1 (end P1) | Golden + property tests green; parity with legacy formula proven; review of `FINANCIAL_ENGINE.md` numbers by business owner |
| G2 (end P4) | Simulated full group life (offline) reconciles: dues, payments, dividends, ledger, trial balance |
| G3 (end P6) | Pilot readiness for offline engine on one internal test company (no real customer data) |
| G4 (end P8) | Load test: 200 participants, 20 bids/s, p95 bid acceptance < 300 ms; reconnect tests pass |
| G5 (end P9) | Legal sign-off recorded; interest golden tests reviewed by finance |

## 5. Migration and rollout strategy
1. **Feature flags:** `Company.engineEnabled` (company), `ChitGroup.engineVersion` (`LEGACY` | `V2`), mode flags (`online` per group). Defaults keep everything legacy.
2. **Shadow mode (P5):** for legacy groups the engine computes the auction outcome alongside `POST /auctions/confirm` and logs differences (no writes) — validates parity on real usage before any conversion.
3. **New groups first:** first engine-enabled groups are newly created groups on a pilot company.
4. **Explicit conversion** of legacy groups (D-32) with dry-run, reconciliation report and approval; reversible by disabling the flag before the first engine settlement.
5. **Ledger cut-over** per company with approved opening balances (D-19); no retroactive posting.
6. **Online bidding** enabled per group only after offline flow is stable and L-05 is cleared.
7. **Interest engine** enabled per company only after the legal gate (L-07..L-09).
8. **Rollback:** flags off; data stays; legacy endpoints unaffected throughout (they are never removed).
9. **Data safety:** every migration rehearsed on a copy of the dev database; no migration modifies or deletes existing rows except adding defaults to new columns.
