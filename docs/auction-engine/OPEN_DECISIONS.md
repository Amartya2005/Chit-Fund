# ChitKart 2.0 — Open Decisions

Status: **awaiting approval.** Each item lists alternatives and, where reasonable, a *recommended default* — recommendations are engineering suggestions, **not** business or legal determinations. Items marked **BLOCKING** must be decided before the phase named in brackets starts (see `IMPLEMENTATION_ROADMAP.md`).

---

## 1. Business rules (D-xx)

| ID | Question | Alternatives | Recommended default | Blocks |
|---|---|---|---|---|
| D-01 | Scope of release 1 | (a) offline engine + schedules only; (b) + member portal; (c) + online bidding; (d) + interest engine | (a) then incremental per roadmap | — |
| D-02 | Member access | (a) new `MEMBER` role linked via `Subscriber.userId`; (b) separate member app/auth; (c) no member access (staff/manager only) | (a) | **BLOCKING [P7, P8]** |
| D-03 | Dividend divisor and remainder | divisor: all tickets (`maxMembers`, existing) / enrolled tickets / non-prized tickets / per chit agreement; remainder: rounding reserve carried to next dividend / foreman / first tickets | enrolled tickets + rounding reserve | **BLOCKING [P1]** |
| D-04 | Maximum wins per ticket; is "one prize per ticket" statutory/contractual? | (a) fixed at 1 and non-overridable; (b) configurable within legal limit | (a) pending L-03 | **BLOCKING [P6]** |
| D-05 | Foreman's own ticket | (a) foreman takes first prize without auction/discount; (b) foreman ticket participates normally; (c) no foreman ticket | none assumed | P5 |
| D-06 | Auction vs contribution frequency combinations offered | M1 aligned only; M1 + M2 (more auctions than periods); all of M1–M3 (`FINANCIAL_ENGINE` §3.7) | M1 first; M2 only after L-06 and a funding policy (who finances prizes paid before contributions are collected) | **BLOCKING [P5]** |
| D-07 | When dividends benefit members | next period credit (existing) / same period / cash payout / accumulate to the end | next period credit (existing) | **BLOCKING [P1]** |
| D-08 | Configuration lock point | when the auction opens / when result entry starts / N hours before the scheduled time | when the auction opens (offline: when result entry starts) | P2 |
| D-09 | What a "bid" is | discount amount (existing data model) / prize amount accepted / percentage | discount amount | P5 |
| D-10 | Total number of auctions in a group | = tickets (each ticket wins once) / = contribution periods / explicit count | = number of tickets | P5 |
| D-11 | No-bid auction and discount below commission (E6) | draw by lots / foreman decides / carry forward / award at minimum discount; commission = F always (existing backend) / min(F, D) / shortfall receivable / disallow D < F (existing UI) | no default — business must decide; until then keep the UI rule D ≥ F and block no-bid settlement | **BLOCKING [P1, P5]** |
| D-12 | Online auction format | open ascending (see current best) / sealed bids; tie-break: earliest valid bid / lots; bidder identity visibility: ticket number only / name | open ascending, earliest bid wins ties, ticket numbers only | **BLOCKING [P8]** |
| D-13 | Commission basis and funding | basis: chit value (existing) / discount / fixed; funding: from discount (A1, existing) / deducted from prize (A2) | A1 + chit value basis (existing) | **BLOCKING [P1]** |
| D-14 | Approvals | maker–checker for settlement always / above threshold / never; approver = any other manager / designated users | above a company-configured threshold, approver ≠ maker | P5 |
| D-15 | Prize deductions and prized-member security | deduct winner's arrears/penalties/fees from prize (yes/no, which); require guarantor/security documents before disbursement; what happens when a prized member defaults later | deduct overdue dues only; document checklist configurable | P5 |
| D-16 | Proxy bidding by staff/manager on behalf of members | not allowed / allowed with written authority / allowed for offline only | not allowed in online mode | P8 |
| D-17 | Attendance / participation records for offline auctions | not recorded (existing) / recorded optional / mandatory | optional, required if L-05 says so | P5 |
| D-18 | (number not used) | — | — | — |
| D-19 | Ledger cut-over | per company date with opening balances / back-post history / never auto-post | per-company cut-over with approved opening entry | **BLOCKING [P4]** |
| D-20 | Hard-coded report figures before cut-over (E8, E9) | keep and label `SAMPLE` / hide / replace with operational-table estimates | label as `SAMPLE` now; replace after cut-over | P4 |
| D-22 | Penalties on chit dues | none (existing) / flat per missed period / % of overdue / daily rate; caps; who may waive | none until L-10; configurable when allowed | **BLOCKING [P3]** |
| D-23 | Payment allocation order | oldest due first, penalty before contribution / contribution before penalty / user-selected (existing) | oldest due first; penalty last for chit dues (pending L-10) | **BLOCKING [P3]** |
| D-24 | Contribution rounding | paise half-up (existing) / whole rupee / last period absorbs difference / track difference to final settlement | paise half-up + tracked difference | P1 |
| D-25 | What Model B is used for | loans to members / loans against unprized tickets / overdue interest on non-chit receivables / Khata credit / not at all | **no default — legal gate** | **BLOCKING [P9]** |

## 2. Conflicting existing behaviour (needs a decision on what to keep)

| Ref | Existing behaviour | Conflict | Decision needed |
|---|---|---|---|
| E1 | Manager UI sent `winningSubscriberId`; API expected `winnerSubscriberId` | in-app auction recording failed (400) | **Resolved in P0** (alias accepted, UI fixed) |
| E2 | UI expected `isPrized` etc. that the API never returned | eligibility display wrong | **Resolved in P0** (derived from `Auction` rows; eligibility endpoint) |
| E3 | Same member can win multiple auctions | contract integrity | **Still open — D-04.** Kept permitted and made explicit in P0 |
| E4 | Dividend ÷ `maxMembers`, remainder dropped | vacant tickets' share and remainders unallocated | **Amounts preserved in P0** (`PENDING_DECISION`); distribution still needs D-03 |
| E5 | Last auction's dividend never credited | money retained silently | **Amount preserved in P0** (`NO_NEXT_INSTALLMENT`); destination needs D-07 / D-11 |
| E6 | Backend recorded commission F even if D < F | commission overstated | **Resolved in P0** (settlement refused); how such auctions *should* be handled needs D-11 / D-13 |
| E7 | Arrears included future instalments | members wrongly shown in arrears | **Resolved in P0** |
| E8 | Hard-coded statements, bankbook split, opening balances | not real data | **Labelled/removed in P0** (`null` + `dataQuality`); ledger-based figures need D-19/D-20 and P4 |
| E9 | Financial periods and compliance data in memory/static | no real locking | **Labelled in P0** (demonstration banner; invented audit entries removed); persistence needs D-20 |
| E10 | INR shown with western grouping | display | **Partially resolved in P0** (auction screen) |
| E11 | Surrender deleted ticket membership row | ticket history lost | **Resolved in P0** (status `SURRENDERED`); rows deleted before P0 are not recoverable |
| — | `ChitGroup.auctionFrequency` column exists but is unused | misleading | Keep for compatibility; superseded by `AuctionSchedule` |
| — | `AuctionBid` table exists but is unused | — | D-30 |
| — | Display-only "2 % late fee" in outstanding report | not charged, not configurable | D-22 |

### 2a. New decisions surfaced by P0
| ID | Question | Notes |
|---|---|---|
| D-35 | What happens to `PENDING_DECISION` dividend allocations already recorded (unfilled seats, remainders, final auctions)? | Visible via `GET /auctions/dividend-allocations/pending`; not posted anywhere. Needs D-03/D-07/D-11 and then an approved, auditable application (adjustment), never a silent update. |
| D-36 | Should KYC verification or overdue dues block auction eligibility in the existing workflow? | P0 reports KYC as informational only and does not check dues (not existing behaviour). |
| D-37 | Should a surrendered member be allowed to re-enrol in the same group? | P0 refuses re-enrolment (unique ticket-per-subscriber constraint kept). |

### 2b. How P1 represents open decisions (nothing decided)

| Decision | P1 policy field(s) | Options available | Not modelled (would need new code once decided) |
|---|---|---|---|
| D-03 | `dividend.divisor`, `dividend.winnerSharesCurrentDividend`, `dividend.unallocatedDestination` | SEATS (existing) / ACTIVE_TICKETS / ACTIVE_NON_PRIZED_TICKETS; PENDING_DECISION / ROUNDING_RESERVE (labels only) | remainder to foreman or to first tickets; carrying the reserve into the next pool |
| D-07 | `dividend.timing` | NEXT_PERIOD_CREDIT (existing) / SAME_PERIOD_CREDIT / CASH_PAYOUT | accumulate to group end |
| D-11 | `commission.whenDiscountBelowCommission` | REJECT (existing) / CAP_TO_DISCOUNT | shortfall receivable; chit-agreement rule; no-bid handling |
| D-13 | `commission.basis`, `commission.source` | CHIT_VALUE (existing) / DISCOUNT / FIXED_AMOUNT; FROM_DISCOUNT (A1, existing) / FROM_PRIZE (A2) | — |
| D-23 | `allocatePayment(..., rule)` | TAGGED_PERIOD (existing) / OLDEST_FIRST | penalty-vs-contribution order inside a period (with L-10) |
| D-24 | `contribution.rounding`, `contribution.differenceHandling` | PAISE_HALF_UP (existing) / PAISE_DOWN / RUPEE_HALF_UP; TRACK / LAST_PERIOD_ADJUSTS | — |
| L-01/L-02 | `legalLimits.maxDiscount`, `legalLimits.maxCommissionPercentOfChit` | any value supplied by legal validation | the values themselves (tests use placeholders) |
| D-31 | — | P1 used a seeded PRNG; no dependency added | — |

`legacyP0Policy()` selects the existing-behaviour option of each row so the engine can be proven equal to P0; it is not an approval of those options.

### 2c. New decisions surfaced by P2

| ID | Question | Current behaviour (P2) |
|---|---|---|
| D-38 | Which commission % is authoritative for a group: the existing `ChitGroup.foremanCommissionPct` (used by the legacy auction workflow) or the CHIT_ECONOMICS policy? | The resolver uses the policy value when set, otherwise the group record (source `GROUP_RECORD`), and warns `RATE_DIFFERS_FROM_GROUP_RECORD` when both exist and differ. The legacy workflow keeps using the group record. |
| D-39 | Who may activate financial settings, and is a second person required (maker–checker for configuration, related to D-14)? | Any manager of the company (super admin for legal limits) may activate; creator and activator are recorded; no separation enforced. |

P2 applied the DATABASE_DESIGN recommendation for D-29 (PostgreSQL enums for the new tables only) and D-21 is not affected (no date columns besides timestamps). D-08 (lock point) is still open: the snapshot mechanism exists, nothing calls it yet.

## 3. Legal and regulatory validation (L-xx) — to be answered by qualified counsel / CA

| ID | Question | Why it matters |
|---|---|---|
| L-01 | Maximum permissible bid discount (and any State variation) for the company's chits | Sets `LEGAL_LIMITS.discount.max`; presets must not exceed it |
| L-02 | Foreman's commission: maximum rate, basis, and whether it is funded from the discount or deducted from the prize (variants A1/A2) | Commission policy defaults |
| L-03 | Whether a ticket may win more than once; rules for the foreman's ticket | Eligibility (D-04, D-05) |
| L-04 | Treatment of prized and non-prized defaulters (security, removal, substitution, recovery, interest/penalty on arrears) | Default handling, deductions |
| L-05 | Whether auctions may be held online / with remote participation; required attendance, minutes, signatures, filings with the Registrar | Online mode (P8), attendance (D-17) |
| L-06 | Whether auction frequency may differ from contribution frequency (weekly/daily auctions) under the applicable Act/Rules and the chit agreement; Prize Chits and Money Circulation Schemes (Banning) Act, 1978 risk for non-standard structures | D-06 |
| L-07 | Whether the company may lend money: RBI NBFC registration (RBI Act s.45-IA) or State Money-Lenders Act licence; State interest-rate caps; Usurious Loans Act, 1918 | Model B gate |
| L-08 | Whether a chit company/foreman may lend to subscribers, accept deposits or advances, or pay interest on them (Banning of Unregulated Deposit Schemes Act, 2019; applicable RBI directions) | Model B and "interest payable" |
| L-09 | If an RBI-regulated entity: Fair Practices Code, Key Fact Statement/all-in cost disclosure, penal-charges directions (incl. no capitalisation of penal charges), digital lending guidelines | Model B penalties, disclosures |
| L-10 | Whether interest/penalties may be charged on overdue chit instalments, and in what form | D-22, D-23 |
| L-11 | GST on foreman's commission and fees; any TDS on dividends/prizes | `CommissionRecord.taxAmount`, posting rules |
| L-12 | Accounting treatment for a chit foreman (pool liability, commission recognition, dividends, foreman ticket) under applicable accounting standards | Posting rules (FINANCIAL_ENGINE §6) |
| L-13 | KYC/AML (PMLA) obligations; Aadhaar storage restrictions (the app stores full `aadhaarNo` in plain text today); DPDP Act, 2023 consent/retention | Member onboarding (P7), data model |
| L-14 | Record retention periods; validity of electronic minutes/records and e-signatures (IT Act, 2000) | Audit design, auction records |

## 4. Technical decisions requiring approval

| ID | Question | Alternatives | Recommendation |
|---|---|---|---|
| D-21 | Date storage in new tables | `DATE`/`timestamptz` (proposed) vs `YYYY-MM-DD` strings like existing tables | `DATE`/`timestamptz` for new tables only |
| D-26 | Multi-currency | INR only / multi-currency | INR only |
| D-27 | Day-count convention for Model B | ACT/365F / ACT/360 / ACT/ACT / 30/360 | ACT/365F, per product |
| D-28 | Variable-rate behaviour | recalc EMI / recalc tenure / both configurable | configurable per product |
| D-29 | Enums for new status columns | PostgreSQL enums (proposed) / strings (existing style) | enums for new tables |
| D-30 | Online bids storage | extend existing unused `AuctionBid` (nullable `auctionId`) / new `SessionBid` table | extend `AuctionBid` |
| D-31 | Property-based testing library | `fast-check` / hand-written randomized tests | `fast-check` (dev dependency only) |
| D-32 | Legacy groups | stay legacy forever / opt-in conversion with reconciliation / bulk conversion | opt-in conversion |
| D-33 | Real-time infrastructure and hosting | API on Vercel + polling only / long-running realtime service (Render/Fly) with SSE or WebSocket + PostgreSQL `LISTEN/NOTIFY` / move the whole API to a long-running host / third-party push (Pusher/Ably) | small long-running realtime service + polling fallback |
| D-34 | Scheduler trigger | Vercel Cron → internal endpoint / Render cron / Supabase `pg_cron` calling the endpoint / in-process timer on a long-running host | external cron calling an idempotent internal endpoint (works on every host); job is idempotent regardless |
| — | Merge `claude/compassionate-davinci-rdydxp` into `main` before P0 | — | yes (all engine work builds on it) |

## 5. Approval checklist for starting implementation
- [ ] D-01 scope of release 1
- [ ] D-03, D-07, D-11, D-13 (Model A core rules) — P1 implemented them as explicit policy options without choosing; a decision is now required before any engine-backed group is activated (P2), not for the library
- [ ] L-01, L-02 answered and legal limit profile values provided — required before any engine group is activated (P2: the profile exists as the super-admin-only `LEGAL_LIMITS` policy; no values are prefilled, and `readyForLock` stays false until both limits are set)
- [ ] D-19 ledger cut-over approach — required for P4
- [ ] D-06 frequency combinations (+ L-06) — required for P5
- [ ] D-33 / D-34 hosting & scheduler trigger
- [ ] P0 defect fixes (E1, E2, E10) approved
