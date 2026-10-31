# ChitKart 2.0 — Auction & Financial Engine: Product Requirements

Status: **DRAFT — architecture phase, not approved for implementation.**
Baseline inspected: branch `claude/compassionate-davinci-rdydxp`, commit `4d6daa8` (clean working tree; `main` is still at `8712e99`, i.e. the stabilization commit is not yet merged).

Conventions used in all documents of this folder:

* **[EXISTING]** — behaviour verified in the current code (file references given).
* **[PROPOSED]** — new behaviour designed here; nothing is implemented.
* **[DECISION]** — requires a business, legal or technical decision; tracked in `OPEN_DECISIONS.md` with an ID (e.g. `D-07`).
* **[LEGAL]** — must be validated by a qualified professional before go-live; nothing in these documents is legal advice.

---

## 1. What exists today (verified)

| Area | Current implementation | Evidence |
|---|---|---|
| Tenancy | `Company` → users, subscribers, groups. Company isolation enforced in every ID-based handler since `4d6daa8`. | `backend/src/security/tenant.ts` |
| Roles | `SUPER_ADMIN`, `MANAGER`, `COLLECTION_STAFF`. **There is no member/subscriber login role.** `Subscriber.userId` exists but no flow gives subscribers access. | `backend/src/middleware/auth.ts` (`ROLES`) |
| Chit group | `ChitGroup`: `chitValue`, `maxMembers`, `totalMonths`, `monthlyInstallment = chitValue / totalMonths`, `foremanCommissionPct` (default 5), `startDate`, `auctionFrequency` (column exists, default `MONTHLY`, **never read by any code**). One assigned staff member. | `prisma/schema.prisma`, `chitGroup.controller.ts` |
| Contribution schedule | `InstallmentSchedule` is **per group, not per member**: one row per month (`installmentNo`, `dueDate`, `scheduledAmount`, `dividendAmount`, `netDueAmount`). Dates generated monthly from `startDate`. | `chitGroup.controller.ts → buildSchedule` |
| Tickets | `ChitGroupMember` (`ticketNumber`, unique per group). Surrender approval **hard-deletes** the membership row. | `payout.controller.ts → processRefund` |
| Collections | `PaymentTransaction` with free `installmentNo` chosen by the user, payment modes CASH/UPI/BANK_TRANSFER/SPLIT/CHEQUE, staff collections need manager approval, reversals keep the record. No allocation of a payment across instalments. | `collection.controller.ts` |
| Auction (offline only) | `POST /auctions/confirm`: manager records group, instalment no., date, discount, winner. Backend computes commission, dividend, per-member dividend, gross prize; updates **next** instalment's dividend; creates a `PENDING` payout — all in one transaction. One auction per `(groupId, installmentNo)`. | `auction.controller.ts` |
| Bids | `AuctionBid` table exists (`auctionId`, `subscriberId`, `bidDiscount`, `bidTime`) but **no code writes it**. No live bidding. | schema; `grep auctionBid` |
| Payouts | `Payout` per auction: gross, deductions, net, PENDING → APPROVED/REJECTED → DISBURSED (final states locked since `4d6daa8`). | `payout.controller.ts` |
| Surrender/refund | `Refund` workflow ASSIGNED_TO_STAFF → SUBMITTED_TO_MANAGER → APPROVED → DISBURSED / REJECTED. | `payout.controller.ts` |
| Accounting | Static 21-account chart created per company; **manual** journal entries only; trial balance/ledger from journal lines. Collections, auctions and payouts are **not posted** to the ledger. Cashbook/bankbook are computed directly from operational tables. | `accounting.controller.ts` |
| Reports | Several **hard-coded sample figures** (see §1.1). | `accounting.controller.ts` |
| Penalties/defaults | Only a display-only "2% late fee" in the outstanding report; nothing is charged or posted. | `subscriber.controller.ts → getMemberOutstanding` |
| Scheduling | **No scheduler, cron or background job exists.** Collection alerts are generated lazily when notifications are listed. | `notification.controller.ts` |
| Company feature flags | `enableAuctions` etc. live in an **in-memory Map** (lost on restart). `Company.settings` column exists but is unused. | `superAdmin.controller.ts` |
| Money | `NUMERIC(15,2)` columns; exact paise arithmetic helpers (`src/lib/money.ts`); API returns JSON numbers. | migration `20261031000200` |

### 1.1 Existing defects and inconsistencies relevant to this phase (not fixed — documentation only)

| # | Finding | Impact |
|---|---|---|
| E1 | The manager UI posts `winningSubscriberId`; the API requires `winnerSubscriberId` (since the original code, commit `8712e99`). | **Recording an auction from the app always fails with HTTP 400.** Auctions can currently only be recorded via direct API calls. |
| E2 | The UI filters/labels "prized" members using `isPrized`, `prizedInstallmentNo`, `currentInstallmentNo`; no endpoint returns these fields. | Every member is shown as "Non-prized (Active bidder)"; the "eligible winner" list is not filtered. |
| E3 | Nothing prevents the same member from winning multiple auctions in a group. | Contractual integrity risk. |
| E4 | Per-member dividend divides by `maxMembers`, not by enrolled/eligible tickets; the paise remainder is discarded. | Dividend for vacant tickets and rounding remainders is never allocated. |
| E5 | The dividend of the **last** auction is computed but never credited (there is no instalment *k+1*). | Dividend silently retained. |
| E6 | Backend records the full foreman commission even when the discount is below the commission (UI blocks this case; API does not). | Commission income overstated by `commission − discount` (see FINANCIAL_ENGINE §3.6). |
| E7 | Outstanding/arrears sum **all** schedule rows, including future-dated instalments. | Arrears overstated; members appear in arrears before dues fall due. |
| E8 | Financial statements, bankbook and cashbook use hard-coded figures (cash ₹74,500; bank ₹3,85,000; receivables ₹1,42,000; prize payable ₹95,000; late fees ₹12,500; cashbook opening ₹50,000; bankbook opening ₹2,50,000 split 70/30 into fictional HDFC/SBI accounts). | Reports are not real. |
| E9 | Super-admin "financial periods" close/reopen are in memory and lock nothing; compliance and integration screens show static/mock data. | No real period locking. |
| E10 | Currency in the UI is formatted with `toLocaleString()` without the `en-IN` locale (e.g. "₹100,000" instead of "₹1,00,000"). | INR formatting inconsistent. |
| E11 | Surrender approval deletes the `ChitGroupMember` row. | Ticket history (who held ticket #n, prized status) is lost. |

### 1.2 P0 status (branch `claude/p0-auction-integrity`)

| # | P0 outcome |
|---|---|
| E1 | **Fixed.** API accepts `winnerSubscriberId` and the legacy `winningSubscriberId`; UI sends the documented name. |
| E2 | **Fixed.** Ticket status, prized flags and eligibility reasons come from `GET /auctions/group/:groupId/eligibility` and group details. |
| E3 | **Unchanged by design** — repeat wins remain permitted and are now explicit (`repeatWinPolicy = PERMITTED_PENDING_DECISION_D04`). Awaits D-04 / L-03. |
| E4, E5 | **Amounts preserved, distribution unchanged.** `AuctionDividendAllocation` records every paisa; unfilled-seat shares, rounding remainders and final-auction dividends are `PENDING_DECISION` (D-03, D-07, D-11). |
| E6 | **Fixed.** Settlement refused when commission > discount (`COMMISSION_EXCEEDS_DISCOUNT`); no formula change. |
| E7 | **Fixed.** Only instalments past their due date are overdue. |
| E8, E9 | **Fixed (labelling).** Sample figures replaced by `null` + `dataQuality`; compliance data marked as demonstration; invented audit entries removed. Ledger-based figures still require P4. |
| E10 | **Partially fixed** (auction screen, new report states). |
| E11 | **Fixed.** Surrender keeps the ticket with `status = SURRENDERED`. |

Eligibility rules enforced server-side in P0 (existing auction workflow): ticket ACTIVE; subscriber ACTIVE. Informational only: already prized, KYC not verified. Everything else in FR-ELG remains future work.

---

## 2. Goals and non-goals

### Goals [PROPOSED]
1. **One** configurable auction engine (not three) supporting daily, weekly, monthly and custom schedules, with auction frequency independent of contribution frequency.
2. Two independent, deterministic financial engines:
   * **Model A — Chit auction economics** (discount, commission, dividend, prize, revised contributions, defaults, settlement).
   * **Model B — Interest engine** (simple/compound, flat/reducing, accrual frequencies, penalties, prepayment, schedules).
3. Hierarchical configuration (company → group → auction) with immutable snapshots at a defined lock point.
4. Two auction operating modes: **manager-recorded offline** and **interactive online** bidding, sharing one lifecycle.
5. Auditable integration with the existing accounting module (event → balanced journal entry), with reversals instead of edits.
6. Explainable member eligibility decisions.
7. A progressive, mobile-first UX for managers, members and staff.

### Non-goals for the first release [PROPOSED, see D-01]
* Payment-gateway integration (UPI collect/auto-debit) — existing manual collection flow is reused.
* Automatic regulatory filings with the Registrar of Chits.
* Rewriting the existing app or removing the existing `/auctions/confirm` endpoint (it remains as the legacy path and is later re-implemented on top of the engine with the same contract).

---

## 3. User roles

| Role | Exists? | Auction/finance responsibilities [PROPOSED] |
|---|---|---|
| Super Admin | yes | Platform templates; **legal limit profiles** per company (e.g. commission/discount ceilings) — only after legal sign-off; enable engine per company; view-only on company finances. |
| Manager (foreman/company admin) | yes | Company & group configuration, schedules, open/close/postpone/cancel auctions, record offline results, approve/settle, payouts, adjustments (maker), interest products. |
| Approver (checker) | **new capability, not a new role** [DECISION D-14] | Second manager who approves settlements/adjustments above thresholds (maker–checker). |
| Collection staff | yes | Collect contributions and loan repayments for assigned groups/accounts; see auction calendar for assigned groups; record attendance / proxy bids only if allowed (D-16). |
| Member (subscriber) | **no — new role required** [DECISION D-02] | View own tickets, dues, dividends, statements; join eligible online auctions and bid; view results and receipts. |

Every new entity and endpoint is company-scoped; members can only see their own tickets and the public state of auctions they are eligible for.

---

## 4. Functional requirements

### 4.1 Configuration (FR-CFG)
| ID | Requirement |
|---|---|
| FR-CFG-01 | Company-level defaults for: auction rules, financial model, commission, dividend, contribution, penalties, default handling, eligibility, scheduling, settlement & payment policy, rounding, interest products. |
| FR-CFG-02 | Group-level overrides of any field marked *overridable at group level*. Unset fields inherit. |
| FR-CFG-03 | Auction-level overrides limited to a whitelist (opening/closing time, closing-rule extension, bid step, min/max discount **within** group bounds, notes). Commission, dividend policy, number of tickets and contribution amounts are **not** auction-overridable. |
| FR-CFG-04 | Legal limit profile (company-level, super-admin managed): hard bounds that no lower level can exceed (e.g. maximum commission %, maximum discount %). Values are **not prefilled**; they must be entered after legal validation (see `OPEN_DECISIONS.md` L-01..L-05). |
| FR-CFG-05 | Every change creates a new immutable version with author, reason and timestamp; history is viewable. |
| FR-CFG-06 | The *effective* configuration (with the source level of each value) can be previewed before saving. |
| FR-CFG-07 | At the **lock point** (auction moves to `OPEN`, or offline result entry starts — D-08) the resolved configuration is snapshotted (JSON + SHA-256 hash + engine version). Later changes never alter a locked auction. |
| FR-CFG-08 | Configuration templates/presets are provided as *starting points*, labelled "not validated for your jurisdiction". |

### 4.2 Scheduling (FR-SCH)
| ID | Requirement |
|---|---|
| FR-SCH-01 | Recurrence types: daily; selected weekdays; every *n* weeks; selected days of month; monthly on the *n*-th weekday; explicit list of dates; every *n* days. |
| FR-SCH-02 | Start date, optional end date or occurrence count; time zone (default `Asia/Kolkata`); opening and closing time. |
| FR-SCH-03 | Holiday calendar per company; per-schedule policy: skip, move to next business day, move to previous business day. |
| FR-SCH-04 | Per-occurrence postpone, reschedule, cancel (with reason); pause/resume a schedule; pausing a group pauses its schedules. |
| FR-SCH-05 | Contribution schedule is configured separately (own frequency) — D-06 defines how auction and contribution periods interact. |
| FR-SCH-06 | Occurrence generation is idempotent: duplicate runs, restarts and concurrent workers can never create two auctions for the same occurrence (DB unique key + transaction). |
| FR-SCH-07 | The number of auctions in a group never exceeds the number of tickets that can still win (prized tickets excluded), unless the configuration explicitly allows otherwise (D-10). |
| FR-SCH-08 | A dry-run preview lists the next N occurrences (after holidays/exceptions) before saving a schedule. |

### 4.3 Auction lifecycle (FR-AUC)
States: `SCHEDULED → OPEN → CLOSED → (PENDING_APPROVAL) → SETTLED`, plus `POSTPONED`, `CANCELLED`, `NO_BID` (D-11). `SETTLED` can only be undone by a **reversal** that creates compensating records (FR-FIN-08).

| ID | Requirement |
|---|---|
| FR-AUC-01 | Both modes share the lifecycle; mode (`OFFLINE`, `ONLINE`, `HYBRID`) is part of the snapshot. |
| FR-AUC-02 | **Offline mode:** manager enters winning discount (or winning bid amount, D-09), winner ticket, attendance/participants (optional, D-17), minutes/notes, attachments; system validates eligibility and bounds, shows a full calculation preview, then *submit for approval* (if configured) or *settle*. |
| FR-AUC-03 | **Online mode:** eligible members join; countdown from server time; current best bid and bid history visible as configured (open vs sealed, D-12); server validates every bid; simultaneous bids are serialized; duplicate submissions are idempotent; closing rule (fixed close, anti-sniping extension, manual close) is configurable; the winner is determined by the configured rule. |
| FR-AUC-04 | No-bid handling is configurable (D-11): draw by lots, foreman decision, carry forward, or minimum-discount award. |
| FR-AUC-05 | Tie-break rule configurable (earliest valid bid, lots) — D-12. |
| FR-AUC-06 | Network interruption: clients can resync from the last seen event sequence; bids are never lost or applied twice. |
| FR-AUC-07 | Postponement/cancellation allowed only before settlement; after bids exist, cancellation requires a reason and voids bids (kept for audit). |
| FR-AUC-08 | Every auction keeps an immutable record of: config snapshot, eligibility decisions, bids (accepted and rejected with reason), result, calculation run, settlement, approvals. |

### 4.4 Financial calculations (FR-FIN)
| ID | Requirement |
|---|---|
| FR-FIN-01 | All calculations run on the backend in a pure, deterministic engine with decimal arithmetic (no JS floating point) and explicit rounding per step. |
| FR-FIN-02 | Model A components: base contribution, discount bounds, commission, dividend pool, per-ticket dividend + remainder, prize (gross/net), revised contributions, outstanding, penalties, default recovery, settlement. |
| FR-FIN-03 | Model B components: interest accrual (simple/compound; flat/reducing; daily/weekly/monthly/annual), repayment schedules, overdue interest, late fees, grace periods, partial and early repayment, rate changes, adjustments. |
| FR-FIN-04 | Every calculation returns a step-by-step breakdown (formula label, inputs, unrounded value, rounding rule, result). |
| FR-FIN-05 | Inputs, config snapshot, engine version and result hashes are stored so any historical result can be recomputed and compared. |
| FR-FIN-06 | Model A and Model B records are stored and posted separately; an auction discount is never treated as interest and lending rules are never applied to chit contributions. |
| FR-FIN-07 | Previews are side-effect free. Settlement is atomic and idempotent. |
| FR-FIN-08 | Settled records are never edited; corrections use reversal + adjustment records with reason and approval. |

### 4.5 Eligibility (FR-ELG)
| ID | Requirement |
|---|---|
| FR-ELG-01 | Rules evaluated per ticket per auction: ticket active; subscriber active and KYC verified (configurable); not already prized beyond `maxWinsPerTicket` (default 1, D-04); outstanding dues ≤ threshold as of cut-off; no defaulted instalments beyond threshold; not suspended; group-specific exclusions (e.g. foreman ticket rules, D-05). |
| FR-ELG-02 | Each evaluation is stored with rule codes, inputs and outcome; members see the reason in plain language. |
| FR-ELG-03 | Manager override of an ineligible decision only where the rule is marked *overridable*, with reason and audit; rules marked *statutory* (D-04, L-03) are never overridable. |

### 4.6 Accounting (FR-ACC)
| ID | Requirement |
|---|---|
| FR-ACC-01 | Each financial event (contribution due raised, payment received, dividend credited, commission earned, prize payable, prize disbursed, refund, penalty, waiver, write-off, interest accrued/received/payable, adjustment) produces exactly one balanced journal entry linked to its source. |
| FR-ACC-02 | Account roles (e.g. `CASH`, `SUBSCRIBER_RECEIVABLE`, `PRIZE_PAYABLE`) map to company accounts; the existing chart of accounts is reused and extended. |
| FR-ACC-03 | Posting is enabled per company from a **cut-over date**; history before cut-over is not re-posted automatically (D-19). |
| FR-ACC-04 | Hard-coded report figures (E8) are replaced by ledger-derived values after cut-over; until then they are labelled as non-ledger figures (D-20). |

### 4.7 Members, staff and notifications
| ID | Requirement |
|---|---|
| FR-MEM-01 | Member portal: upcoming auctions, eligibility status with reasons, live auction room, bid history, results, contribution history, dividends, outstanding, receipts/statements, loan/interest details where applicable. |
| FR-STF-01 | Staff: daily collection list per assigned group including revised (post-dividend) amounts, auction calendar for assigned groups, record collections, (optional) mark attendance at offline auctions. |
| FR-NOT-01 | Notifications: auction scheduled/opening soon/opened/closing soon/result; dues; penalties; payout status — reuse the existing `Notification` model and in-app channel. |

### 4.8 Non-functional
* Tenant isolation on every new table and endpoint (company derived from the authenticated user, never from the client).
* Concurrency: bids, closing and settlement are serialized per auction; uniqueness enforced in the database.
* Auditability: append-only histories; reversals instead of edits.
* Time: all instants stored in UTC (`timestamptz`); business dates (due dates, auction dates) stored as `date` in the company time zone (D-21, existing code stores dates as `YYYY-MM-DD` strings).
* Performance targets (initial): bid acceptance p95 < 300 ms server time; 200 concurrent participants per auction; schedule generation for 10k groups < 1 min.
* Accessibility: WCAG 2.1 AA targets for the web build; large touch targets on mobile.

---

## 5. User journeys

### J1 — Manager sets up a new group with weekly auctions and monthly contributions
1. Groups → New group → choose template "Weekly auction / monthly contribution" (labelled *not legally validated*).
2. Wizard step 1 *Basics*: chit value, tickets, contribution amount (computed, editable per rounding rule).
3. Step 2 *Auction rules*: mode (offline/online), discount min/max (bounded by the company legal profile), commission (bounded), dividend policy.
4. Step 3 *Schedule*: weekly on Saturday 11:00–11:30, start date, holidays policy → preview of the next 10 auctions.
5. Step 4 *Contributions & defaults*: monthly due day, grace days, penalty rule, eligibility thresholds.
6. Step 5 *Review*: plain-language summary + worked example with the group's own numbers → save (creates config version 1).

### J2 — Offline auction
Calendar → today's auction → *Record result* → enter discount + winner → eligibility check passes → preview (commission, dividend pool, per-ticket dividend, remainder, prize, deductions for the winner's arrears) → *Submit for approval* → approver reviews → *Settle* (confirmation dialog) → payout created `PENDING`, dividends credited, dues revised, journal entries posted, members notified.

### J3 — Online auction (member)
Notification "Auction opens in 15 minutes" → member opens auction room → sees eligibility "You can bid" → countdown → enters discount (validated: ≥ current best + step, ≤ maximum) → receives acceptance with sequence number → outbid notification → auction closes (with extension if configured) → result screen with own position and the dividend they will receive.

### J4 — Late payment and default
Due date passes → grace period → penalty charged per rule (journal entry) → member marked *in arrears*; if threshold exceeded, ineligible for the next auction with reason "₹X overdue since dd-mm" → staff collects → payment allocated (penalty first or per waterfall D-23) → eligibility restored.

### J5 — Interest-bearing account (Model B, only if approved — D-25)
Manager creates an account with a configured interest product → schedule preview (EMI/flat) → disbursement → daily/monthly accruals posted → repayments allocated by waterfall → prepayment quote → closure.

### J6 — Correction
Manager discovers wrong winner after settlement → *Reverse settlement* (maker, reason) → approver approves → reversal journal entries, dividends reversed, payout cancelled if not disbursed (if disbursed: recovery adjustment) → auction returns to `CLOSED` for re-entry.

---

## 6. Business rules summary

| Rule | Default proposed | Source / status |
|---|---|---|
| Commission formula | `round(chitValue × commission%)` funded from discount (existing A1) | [EXISTING], legal check L-02 |
| Dividend pool | `max(0, discount − commission)` | [EXISTING] |
| Dividend divisor | **enrolled tickets** (existing uses `maxMembers`) | D-03 |
| Dividend timing | credited against the next contribution period (existing) | D-07 |
| Remainder of dividend split | carried to a group rounding reserve, distributed with the next dividend | D-03 |
| Wins per ticket | 1 (statutory nature to confirm) | D-04, L-03 |
| Discount bounds | min ≥ 0; max from legal profile | L-01 |
| Commission bound | from legal profile | L-02 |
| No-bid auction | not defined in current code | D-11 |
| Penalties | not charged today (display only) | D-22 |
| Payment allocation order | not defined (user picks instalment) | D-23 |
| Rounding | paise, half-up for computed charges, floor for per-ticket splits with tracked remainder | FINANCIAL_ENGINE §2 |
