# ChitKart 2.0 — Financial Engine Design

Status: **DRAFT — design only.** Labels: [EXISTING] verified in code · [PROPOSED] · [DECISION D-xx] · [LEGAL L-xx] (see `OPEN_DECISIONS.md`).
All worked examples below were computed with arbitrary-precision decimal arithmetic (Python `decimal`, 50 significant digits) and rounded exactly as specified.

---

## 1. Engine architecture [PROPOSED]

```
backend/src/finance/                      (new, pure — no Prisma, no I/O, no Date.now())
  decimal.ts        Decimal wrapper (decimal.js; precision 40), money/rate types, rounding helpers
  rounding.ts       RoundingPolicy (mode per operation), cumulative-rounding helper, remainder tracking
  chit/             Model A: contribution, auction (commission/dividend/prize), dues revision, penalties, settlement plan
  interest/         Model B: day count, accrual, schedule (flat / reducing / bullet), allocation waterfall, prepayment
  breakdown.ts      Step recorder: { step, formula, inputs, unrounded, rounding, result }
  version.ts        ENGINE_VERSION (semver); bumped on any behaviour change
backend/src/services/finance/             (impure orchestration: loads snapshot + data, calls engine, persists runs)
```

Rules:
1. **Pure functions.** Input = typed values + config snapshot + an explicit `asOf` date. Output = result + breakdown. Same input ⇒ same output (byte-identical JSON).
2. **No floating point.** `decimal.js` (already a transitive dependency via `Prisma.Decimal`; pin it as a direct dependency) for multiplication/division/powers; the existing integer-paise helpers in `src/lib/money.ts` remain valid for add/subtract of 2-dp values and are re-implemented on top of `decimal.js` for the engine.
3. **Explicit rounding.** Every operation that can produce more than 2 decimals names its rounding mode; there is no implicit rounding.
4. **Reproducibility.** Each persisted calculation stores `engineVersion`, the config snapshot hash, canonical JSON inputs and the outputs (`CalculationRun`, see DATABASE_DESIGN §5).
5. **Independence.** `chit/` and `interest/` share only `decimal.ts`/`rounding.ts`/`breakdown.ts`. Neither imports the other.
6. **Backend authority.** The frontend may show previews returned by the API; it never computes amounts that are persisted. (Today the manager screen computes its own preview — `AuctionsPayoutsTab.tsx` lines 89–96 — with JS floats; this becomes display-only of the API preview.)

---

## 2. Currency, precision and rounding [PROPOSED]

| Item | Rule |
|---|---|
| Currency | INR only (D-26 for multi-currency: out of scope). |
| Stored precision | 2 decimals (paise), `NUMERIC(15,2)` — [EXISTING] since migration `20261031000200`. |
| Rates | stored as `NUMERIC(9,6)` percent (e.g. `12.000000` = 12 % p.a.) [PROPOSED]. |
| Intermediate precision | `decimal.js` precision 40 significant digits; no intermediate rounding unless a step says so. |
| Interest accrual intermediate | stored unrounded at `NUMERIC(24,10)` for reproducibility; postings rounded (§4.3 cumulative rounding). |
| Default rounding modes | `HALF_UP` (round half away from zero) for computed charges/income (commission, interest posting, penalty, EMI); `DOWN` (truncate toward zero) for splitting a pool among tickets, with the remainder tracked explicitly. |
| Whole-rupee rounding | optional per company for contributions and EMIs (common practice, D-24). Default: off (paise). |
| Remainders | never discarded: every split returns `(perShare, remainder)`; remainder goes to the configured destination (D-03). |
| Display | `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })` → ₹1,00,000.00 (fixes E10). |

Formal definition used below: `R½(x)` = round half-up to paise, `R↓(x)` = truncate to paise, `⌊x⌋` integer floor.

---

## 3. Model A — Chit auction economics

### 3.1 Parameters

| Symbol | Config key | Level | Meaning |
|---|---|---|---|
| `C` | `chitValue` | group | Chit amount (total pot per auction). [EXISTING `ChitGroup.chitValue`] |
| `N` | `ticketCount` | group | Number of tickets. [EXISTING `maxMembers`] |
| `P` | `contributionPeriods` | group | Number of contribution periods. [EXISTING `totalMonths`] |
| `I` | `baseContribution` | group | Contribution per ticket per period before dividend. [EXISTING `monthlyInstallment`] |
| `c%` | `commission.rate` | company→group | Foreman commission rate. [EXISTING `foremanCommissionPct`, default 5] |
| — | `commission.basis` | company→group | `CHIT_VALUE` [EXISTING] · `DISCOUNT` · `FIXED` (D-13) |
| — | `commission.source` | company→group | `FROM_DISCOUNT` [EXISTING, variant A1] · `FROM_PRIZE` (variant A2) (D-13) |
| `Dmin`,`Dmax` | `discount.min`, `discount.max` | company→group→auction (within legal profile) | Allowed winning discount (absolute ₹ or % of `C`). [EXISTING: only `0 ≤ D < C`] |
| `step` | `bidding.step` | group→auction | Minimum increment between bids. |
| — | `dividend.divisor` | company→group | `ALL_TICKETS` [EXISTING uses `maxMembers`] · `ENROLLED_TICKETS` · `NON_PRIZED_TICKETS` (D-03) |
| — | `dividend.timing` | company→group | `NEXT_PERIOD_CREDIT` [EXISTING] · `SAME_PERIOD_CREDIT` · `CASH_PAYOUT` (D-07) |
| — | `dividend.remainder` | company→group | `ROUNDING_RESERVE` (carry) · `FOREMAN` · `FIRST_TICKETS` (D-03) |
| — | `rounding.contribution` | company | `PAISE_HALF_UP` · `RUPEE_HALF_UP` · `LAST_PERIOD_ADJUSTS` (D-24) |

### 3.2 Base contribution
```
I_raw = C / P
I     = R½(I_raw)                         (or whole-rupee per D-24)
Δ     = C − I × P                         (rounding difference over the life of the group)
```
[EXISTING] computes `I = roundMoney(C / P)` and ignores Δ.
[PROPOSED] Δ is handled by policy `LAST_PERIOD_ADJUSTS` (default): the final period's base contribution is `I + Δ/N`… which itself may not be exact per ticket, so the recommended default is **`TRACK_DIFFERENCE`**: Δ is recorded on the group and settled by the final auction's prize computation (prize uses actual pool collected). D-24 decides.

Worked example A-1: `C = 5,00,000`, `P = 30` → `I_raw = 16,666.666…`, `R½ = 16,666.67`, `30 × 16,666.67 = 5,00,000.10` → over-collection Δ = −₹0.10 per ticket over the life (₹3.00 for 30 tickets). With `R↓` it would be ₹16,666.66 and an under-collection of ₹0.20 per ticket. The current code silently keeps the over-collection.

### 3.3 Auction outcome — variant A1 (commission funded by discount) [EXISTING formula]

```
F       = R½( C × c% / 100 )                                  commission (basis CHIT_VALUE)
Dpool   = max(0, D − F)                                       dividend pool
n_div   = divisor per dividend.divisor                        (EXISTING: N = maxMembers)
d       = R↓( Dpool / n_div )                                 dividend per ticket
r       = Dpool − d × n_div                                   remainder (EXISTING: discarded)
G       = C − D                                               gross prize
Net     = G − Σ deductions                                    (deductions: winner's arrears, penalties, fees — D-15)
```
Constraint: `Dmin ≤ D ≤ Dmax`, `D < C`, and (A1) `D ≥ F` unless D-11/D-13 defines the shortfall treatment (see §3.6).

**Worked example A-2 (matches the existing tests and the existing code):**
`C = 1,00,000; N = 10; P = 10; c% = 5; D = 15,000`
| Step | Formula | Value |
|---|---|---|
| Base contribution | 1,00,000 / 10 | ₹10,000.00 |
| Commission | R½(1,00,000 × 5 %) | ₹5,000.00 |
| Dividend pool | 15,000 − 5,000 | ₹10,000.00 |
| Per ticket | R↓(10,000 / 10) | ₹1,000.00 (remainder ₹0.00) |
| Gross prize | 1,00,000 − 15,000 | ₹85,000.00 |
| Next period due per ticket | 10,000 − 1,000 | ₹9,000.00 |

**Worked example A-3 (rounding):** `C = 5,00,000; N = 30; c% = 5; D = 50,000`
`F = 25,000.00; Dpool = 25,000.00; d = R↓(833.333…) = 833.33; r = 25,000.00 − 833.33 × 30 = ₹0.10; G = 4,50,000.00`.
Existing code: `dividendPerMember = 833.33`, ₹0.10 is lost. Proposed: ₹0.10 to the rounding reserve and added to the next dividend pool.

### 3.4 Variant A2 (commission deducted from prize) [PROPOSED alternative, D-13]
```
F     = R½(C × c%)        Dpool = D        G = C − D − F
```
Example with A-2 inputs: `Dpool = 15,000`, `d = 1,500`, `G = 80,000`. Whether A2 is permissible under the applicable chit agreement/rules must be validated (L-02). **Default remains A1** because it is the existing behaviour.

### 3.5 Revised contributions and dues [PROPOSED per-member dues]
Today dues exist only per group (`InstallmentSchedule`). Proposed per-ticket dues (`MemberDue`, DATABASE_DESIGN §4):
```
due(t, k).gross       = I_k                                        (I, or I + adjustment in the final period)
due(t, k).dividend    = Σ dividends credited to ticket t for period k   (per dividend.timing)
due(t, k).penalty     = Σ penalties charged on period k
due(t, k).net         = gross − dividend + penalty
due(t, k).outstanding = net − Σ allocations(t, k)                  (≥ 0)
outstanding(t, asOf)  = Σ_{k : dueDate(k) ≤ asOf} due(t, k).outstanding
```
Fixes E7: only periods with `dueDate ≤ asOf` count as arrears; future periods are "upcoming".

### 3.6 Commission shortfall when D < F (existing inconsistency E6)
Under A1 the cash actually available to fund commission in an auction is `min(D, F)`. Lifecycle example A-4 (10 tickets, ₹1,00,000, 5 %, discounts 15,000 / 12,000 / 10,000 / 9,000 / 8,000 / 7,000 / 6,000 / 5,000 / 5,000 / 0, dividend credited next period, divisor 10):

| k | D | F recorded (existing) | Dpool | d | due/ticket | pool collected | prize | collected − prize |
|---|---|---|---|---|---|---|---|---|
| 1 | 15,000 | 5,000 | 10,000 | 1,000 | 10,000 | 1,00,000 | 85,000 | 15,000 |
| 2 | 12,000 | 5,000 | 7,000 | 700 | 9,000 | 90,000 | 88,000 | 2,000 |
| 3 | 10,000 | 5,000 | 5,000 | 500 | 9,300 | 93,000 | 90,000 | 3,000 |
| 4 | 9,000 | 5,000 | 4,000 | 400 | 9,500 | 95,000 | 91,000 | 4,000 |
| 5 | 8,000 | 5,000 | 3,000 | 300 | 9,600 | 96,000 | 92,000 | 4,000 |
| 6 | 7,000 | 5,000 | 2,000 | 200 | 9,700 | 97,000 | 93,000 | 4,000 |
| 7 | 6,000 | 5,000 | 1,000 | 100 | 9,800 | 98,000 | 94,000 | 4,000 |
| 8 | 5,000 | 5,000 | 0 | 0 | 9,900 | 99,000 | 95,000 | 4,000 |
| 9 | 5,000 | 5,000 | 0 | 0 | 10,000 | 1,00,000 | 95,000 | 5,000 |
| 10 | 0 | 5,000 | 0 | 0 | 10,000 | 1,00,000 | 1,00,000 | 0 |
| **Σ** | 77,000 | **50,000** | 32,000 | | | 9,68,000 | 9,23,000 | **45,000** |

Cash left with the foreman = ₹45,000, but recorded commission = ₹50,000 → ₹5,000 overstated (auction 10, where `D = 0 < F`). The last auction's dividend (if any) would also have no period to be credited to (E5). Options (D-11, D-13): (a) enforce `D ≥ F` for every auction (UI rule today); (b) commission = `min(F, D)`; (c) shortfall recorded as receivable from the group / borne by foreman; (d) last-auction special rule defined by the chit agreement. **No default is assumed.**

### 3.7 Auction frequency vs contribution frequency (D-06)
The engine models **auction periods** and **contribution periods** as two independent calendars linked by a mapping rule:

| Option | Mapping | Consequence |
|---|---|---|
| M1 "aligned" (existing) | one auction per contribution period | Prize funded by that period's collections. |
| M2 "multiple auctions per period" (e.g. weekly auctions, monthly contributions) | auctions 1..m fall inside period k | Prizes paid before the period's contributions are collected → **funding gap financed by the foreman** (liquidity + legality L-06). Dividends of all auctions in period k are credited to period k+1 (sum), unless D-07 says otherwise. Number of tickets still bounds total auctions. |
| M3 "fewer auctions than periods" (e.g. monthly contributions, quarterly auctions) | several periods per auction | Pool accumulates; prize may exceed `C` unless `C` is defined per auction. |

The engine supports all three structurally (dues attach to contribution periods; dividends attach to auctions with a target period). Which combinations a company may offer is a business/legal decision (D-06, L-06).

### 3.8 Penalties and default handling (D-22)
Supported penalty rule types (all parameters from snapshot, all optional):
```
FLAT_PER_MISSED_PERIOD     penalty = amount                               once per overdue period after grace
PERCENT_OF_OVERDUE         penalty = R½(outstanding × p%)                 once, or per elapsed period
DAILY_RATE_ON_OVERDUE      penalty = R½(outstanding × p% × days / 365)    accrued via cumulative rounding
CAP                        Σ penalty(t, k) ≤ cap (absolute or % of due)
```
Grace: penalty starts after `graceDays` from `dueDate`. [EXISTING] only a display-only "2 % of arrears" exists; it is not charged. Penalty on chit dues is **not interest** and is posted to penalty income, never to interest accounts (FR-FIN-06).
Default states per ticket: `CURRENT → OVERDUE (after grace) → DEFAULTED (after defaultAfterDays or n missed periods)`. Prized defaulters vs non-prized defaulters are treated differently in most chit agreements (recovery from security/guarantor vs removal & substitution) — **policy not assumed** (D-15, L-04).

### 3.9 Settlement plan (deterministic)
Given snapshot + result + member state at `asOf`, the engine returns a *settlement plan* (no side effects):
1. Commission record (`F` or per D-13).
2. Dividend records: one per eligible ticket (`d`), plus remainder record (`r`) to its destination.
3. Due adjustments: dividend credit lines against the target period (§3.5).
4. Prize: gross `G`; deductions (winner's outstanding dues/penalties if policy says so, D-15); net.
5. Accounting events (§6).
The service applies the plan in one database transaction guarded by a unique settlement key (DATABASE_DESIGN §6).

---

## 4. Model B — Interest engine (independent)

### 4.1 Scope and subject (D-25)
The engine operates on an abstract **interest-bearing account**: `principal`, `disbursementDate`, `product snapshot`, ledger of events. What business product uses it (loans to members, loans against unprized tickets, advances, overdue interest on non-chit receivables) is a decision with **significant regulatory impact** (L-07..L-10). The engine itself is product-agnostic and is never invoked for chit contributions or discounts.

### 4.2 Parameters
| Key | Values |
|---|---|
| `interestType` | `SIMPLE`, `COMPOUND` |
| `method` | `FLAT`, `REDUCING_BALANCE`, `OUTSTANDING_PRINCIPAL` (simple interest on daily outstanding principal) |
| `rate` | annual nominal % (fixed) or rate schedule `[{effectiveFrom, rate}]` (variable) |
| `dayCount` | `ACT_365F` (default proposed), `ACT_360`, `ACT_ACT`, `30_360` (D-27) |
| `accrualFrequency` | `DAILY`, `WEEKLY`, `MONTHLY`, `ANNUAL` (posting frequency of accrued interest) |
| `compounding` | `NONE`, `DAILY`, `MONTHLY`, `QUARTERLY`, `ANNUAL` (only with `COMPOUND`) |
| `repayment` | frequency, count, first due date, type `EMI`, `EQUAL_PRINCIPAL`, `INTEREST_ONLY_THEN_BULLET`, `BULLET` |
| `graceDays` | days after due date before overdue charges |
| `overdue` | penal rate on overdue amount (and base: overdue instalment / overdue principal), or none |
| `lateFee` | fixed or % of overdue instalment, once per missed instalment, optional cap |
| `prepayment` | allowed?, lock-in, charge %, recalculation `REDUCE_EMI` / `REDUCE_TENURE` |
| `allocationWaterfall` | ordered list, default proposed: fees → penal charges → overdue interest → overdue principal → current interest → current principal → prepayment (D-23) |
| `rounding` | EMI `HALF_UP` paise (or rupee), interest postings via cumulative rounding, last instalment absorbs residual |

### 4.3 Accrual and cumulative rounding
```
dailyRate      = annualRate / 100 / daysInYear(dayCount)
accrual(day)   = base(day) × dailyRate                      (unrounded, NUMERIC(24,10))
cum(n)         = Σ_{day ≤ n} accrual(day)
posted(n)      = R½(cum(n)) − R½(cum(n−1))                   per posting date
```
Guarantees Σ posted = R½(total accrual) — no rounding drift. Example B-0: ₹1,00,000 at 12 % ACT/365 posted daily for 31 days → daily postings are ₹32.87 or ₹32.88, total ₹1,019.18 = R½(1,00,000 × 0.12 × 31/365).

### 4.4 Formulas and worked examples

**B-1 Simple interest (outstanding principal, ACT/365F).** `interest = P × r × days / 365`
₹1,00,000 at 12 % for 30 days = 986.3013698… → **₹986.30**.

**B-2 Compound interest.** Capitalisation at each compounding date: `B_{j+1} = B_j × (1 + r/m)` (iterated, integer exponent only, so it stays deterministic in decimal).
₹1,00,000 at 12 % compounded monthly for 12 months → `1,00,000 × 1.01¹²` = 1,12,682.503… → **₹1,12,682.50** (interest ₹12,682.50).
Same rate compounded daily (12 %/365, 365 days) → **₹1,12,747.46**.

**B-3 Flat interest.** `totalInterest = P × r × years`; `instalment = (P + totalInterest) / n`; interest share per instalment = `totalInterest / n`.
₹1,20,000 at 12 % flat for 12 months → total interest ₹14,400; instalment **₹11,200** (₹10,000 principal + ₹1,200 interest).
Disclosure note: the equivalent reducing-balance rate is ≈ **21.46 % p.a.** (monthly IRR 1.788 %). If the operator is a regulated lender, effective-rate disclosure obligations may apply (L-09).

**B-4 Reducing balance EMI.** `i = r / 12`; `EMI = R½( P × i × (1+i)ⁿ / ((1+i)ⁿ − 1) )`; each period `interest_k = R½(B_{k−1} × i)`, `principal_k = EMI − interest_k`; the last instalment pays the remaining balance plus its interest.
₹1,00,000, 12 % p.a., 12 monthly → EMI raw 8,884.8788… → **₹8,884.88**.

| k | Payment | Interest | Principal | Balance |
|---|---|---|---|---|
| 1 | 8,884.88 | 1,000.00 | 7,884.88 | 92,115.12 |
| 2 | 8,884.88 | 921.15 | 7,963.73 | 84,151.39 |
| 3 | 8,884.88 | 841.51 | 8,043.37 | 76,108.02 |
| 4 | 8,884.88 | 761.08 | 8,123.80 | 67,984.22 |
| 5 | 8,884.88 | 679.84 | 8,205.04 | 59,779.18 |
| 6 | 8,884.88 | 597.79 | 8,287.09 | 51,492.09 |
| 7 | 8,884.88 | 514.92 | 8,369.96 | 43,122.13 |
| 8 | 8,884.88 | 431.22 | 8,453.66 | 34,668.47 |
| 9 | 8,884.88 | 346.68 | 8,538.20 | 26,130.27 |
| 10 | 8,884.88 | 261.30 | 8,623.58 | 17,506.69 |
| 11 | 8,884.88 | 175.07 | 8,709.81 | 8,796.88 |
| 12 | **8,884.85** | 87.97 | 8,796.88 | 0.00 |
| Σ | 1,06,618.53 | 6,618.53 | 1,00,000.00 | |

**B-5 Overdue interest.** `penal = R½(overdueAmount × penalRate × daysBeyondGrace / 365)`.
Instalment ₹8,884.88 overdue, 24 % p.a., 15 days beyond grace → **₹87.63**. Whether penal amounts may be compounded or capitalised depends on the operator's regulator (L-09) — default: never compounded.

**B-6 Prepayment.** After instalment 6 (balance ₹51,492.09) the borrower prepays ₹20,000 → new balance ₹31,492.09.
* `REDUCE_EMI` (keep 6 remaining instalments): new EMI **₹5,433.91**.
* `REDUCE_TENURE` (keep EMI ₹8,884.88): repaid in **4** more instalments (last instalment principal ₹5,524.25 + interest ₹55.24).
* Prepayment charge 2 % (if configured): ₹400.00 (posted as fee income, not interest).

**B-7 Partial payment allocation.** Due: instalment ₹8,884.88 (interest ₹597.79, principal ₹8,287.09), penal ₹87.63, late fee ₹200; payment ₹5,000 with default waterfall → late fee 200.00 → penal 87.63 → interest 597.79 → principal 4,114.58; remaining principal overdue ₹4,172.51.

**B-8 Variable rate.** Rate changes split accrual intervals at `effectiveFrom`; EMI is recalculated on the next instalment date for `REDUCING_BALANCE` when policy `RECALC_EMI` (or tenure adjusted with `RECALC_TENURE`). D-28.

### 4.5 Separation from Model A
* Separate tables (`InterestAccount`, `InterestAccrual`, `RepaymentInstallment`) and separate account roles (`INTEREST_INCOME`, `LOAN_RECEIVABLE`); never the chit dividend/discount tables.
* A loan against an unprized ticket (if ever approved) links to the ticket by reference only; the chit settlement never reads interest records except as an explicit configured deduction line ("recover loan from prize"), which is posted as a loan repayment event, not as a chit discount.

---

## 5. Financial invariants (to be enforced by tests and, where possible, DB constraints)

| ID | Invariant |
|---|---|
| INV-G1 | All persisted amounts have ≤ 2 decimals; rates ≤ 6; unrounded accruals ≤ 10. |
| INV-G2 | Every engine call is deterministic: `hash(output) = f(engineVersion, configHash, inputHash)`; recomputation of any `CalculationRun` reproduces its stored output. |
| INV-G3 | Every posted journal entry balances: Σ debits = Σ credits (paise-exact). |
| INV-G4 | Every financial event has exactly one journal entry; every auto-posted journal entry has exactly one source event. |
| INV-G5 | Settled/posted records are immutable; corrections net to zero with their reversal. |
| INV-A1 | (A1) `F + Dpool = D` when `D ≥ F`; `Dpool ≥ 0`. (A2) `Dpool = D`. |
| INV-A2 | `Σ dividend records + remainder = Dpool` exactly. |
| INV-A3 | `G = C − D` (A1) or `C − D − F` (A2); `Net = G − Σ deductions ≥ 0`. |
| INV-A4 | Per contribution period k: `Σ_t due(t,k).gross = N_k × I_k`; `Σ_t due(t,k).dividend = Σ dividends targeted to k`. |
| INV-A5 | `0 ≤ outstanding(t,k) ≤ net(t,k)`; allocations never exceed dues (+ advance bucket). |
| INV-A6 | At most one settled result per auction occurrence; at most `maxWinsPerTicket` wins per ticket per group. |
| INV-A7 | `Dmin ≤ D ≤ Dmax ≤ legalMax`, `F ≤ legalCommissionMax`. |
| INV-A8 | Group life: `Σ collected − Σ prizes = Σ commissions_funded + Σ undistributed dividend + reserve balance` (cash conservation, §3.6). |
| INV-B1 | Schedule: `Σ principal components = P`; final balance = 0.00. |
| INV-B2 | Accrual: `Σ posted accrual = R½(Σ unrounded accrual)` (cumulative rounding). |
| INV-B3 | Allocation: `Σ allocated = payment` (with any surplus to advance/prepayment), each bucket ≤ its outstanding. |
| INV-B4 | Penal/overdue amounts never accrue on themselves unless the snapshot explicitly allows it (default: never). |
| INV-B5 | Interest and chit records never share an account role or a source table. |

Property-based tests (`fast-check`, D-31) generate random valid configs and amounts to check INV-A1..A5 and INV-B1..B4; golden tests pin the worked examples above.

---

## 6. Accounting integration

### 6.1 Current state [EXISTING]
* `Account` per company (21 template accounts, codes 1001–5006), `JournalEntry` + `JournalEntryLine`, manual posting only (`POST /accounting/journal-entries`), `currentBalance` updated by manual entries.
* No operational event (collection, auction, payout, refund, expense) creates journal entries. Cashbook/bankbook/statements read operational tables and hard-coded figures (E8).

### 6.2 Proposed posting architecture
```
Domain action (settle auction, allocate payment, accrue interest…)
   └─ same DB transaction ─▶ FinancialEvent (type, sourceType, sourceId, amounts, idempotencyKey UNIQUE)
                              └─ PostingEngine (rules per event type + company AccountMapping)
                                   └─ JournalEntry (sourceEventId UNIQUE, balanced) + lines (with groupId/subscriberId/accountRef dimensions)
```
* Posting happens **in the same transaction** as the domain change (no eventual-consistency gap), using rules from a versioned posting-rule table so the mapping is auditable.
* Reversal = new event `*_REVERSED` → journal entry with swapped debits/credits, `reversalOfId` set.
* Journal numbers come from the existing atomic `CompanySequence` (`journalEntry` key).

### 6.3 Account roles → existing chart (+ proposed additions)
| Role | Existing account | Proposed new account |
|---|---|---|
| `CASH` | 1001 Cash on Hand | — |
| `BANK` | 1002 / 1003 (company chooses) | — |
| `SUBSCRIBER_RECEIVABLE` | 1100 Subscriber Instalment Receivables | — |
| `SUBSCRIBER_ADVANCE` | 2002 Subscriber Advance Collections | — |
| `PRIZE_PAYABLE` | 2001 Prize Money Payable | — |
| `CHIT_POOL_PAYABLE` | — | 2003 Chit Group Pool (per-group dimension) |
| `DIVIDEND_PAYABLE` | — | 2004 Dividend Payable to Subscribers |
| `ROUNDING_RESERVE` | — | 2005 Dividend Rounding Reserve |
| `COMMISSION_INCOME` | 4001 Foreman Commission Income ("5% Pool" — label hard-codes 5 %, rename proposed) | — |
| `PENALTY_INCOME` | 4002 Default Penalty & Late Fee Charges | — |
| `FEE_INCOME` | 4003 Documentation & Passbook Fees | — |
| `GST_OUTPUT` | — | 2300 GST Output Payable (if applicable, L-11) |
| `LOAN_RECEIVABLE` | — | 1300 Loans Receivable (Model B only) |
| `INTEREST_RECEIVABLE` | — | 1310 Interest Receivable (Model B) |
| `INTEREST_INCOME` | (4004 is *bank* interest — not reused) | 4005 Interest Income on Loans (Model B) |
| `BAD_DEBT_EXPENSE` | — | 5007 Bad Debts Written Off |

The chit-fund foreman's accounting treatment (whether pool money is a liability of the group, recognition of commission, treatment of the foreman's own ticket) **must be confirmed by a chartered accountant** (L-12). The rules below are a structural proposal.

### 6.4 Posting rules (proposed, Model A)
| Event | Debit | Credit |
|---|---|---|
| `DUE_RAISED` (period k, ticket t, gross `I`) | SUBSCRIBER_RECEIVABLE `I` | CHIT_POOL_PAYABLE `I` |
| `PAYMENT_RECEIVED` (allocated to dues) | CASH/BANK | SUBSCRIBER_RECEIVABLE |
| `PAYMENT_RECEIVED` (unallocated / advance) | CASH/BANK | SUBSCRIBER_ADVANCE |
| `AUCTION_SETTLED` (A1) | CHIT_POOL_PAYABLE `C` | PRIZE_PAYABLE `G`; COMMISSION_INCOME `F`; DIVIDEND_PAYABLE `Dpool − r`; ROUNDING_RESERVE `r` |
| `DIVIDEND_APPLIED` (credit against due) | DIVIDEND_PAYABLE `d` | SUBSCRIBER_RECEIVABLE `d` |
| `PRIZE_DISBURSED` | PRIZE_PAYABLE `G` | BANK `Net`; SUBSCRIBER_RECEIVABLE `deductions` |
| `PENALTY_CHARGED` / `PENALTY_WAIVED` | SUBSCRIBER_RECEIVABLE / PENALTY_INCOME | PENALTY_INCOME / SUBSCRIBER_RECEIVABLE |
| `REFUND_PAID` (surrender) | CHIT_POOL_PAYABLE (or SUBSCRIBER_ADVANCE) | BANK |
| `WRITE_OFF` | BAD_DEBT_EXPENSE | SUBSCRIBER_RECEIVABLE |
| `ADJUSTMENT` | per adjustment type (always with reason + approval) | |

Check for A-2: `C 1,00,000 = G 85,000 + F 5,000 + Dpool 10,000` ✔.

### 6.5 Posting rules (proposed, Model B)
| Event | Debit | Credit |
|---|---|---|
| `LOAN_DISBURSED` | LOAN_RECEIVABLE | BANK/CASH |
| `INTEREST_ACCRUED` | INTEREST_RECEIVABLE | INTEREST_INCOME |
| `REPAYMENT_RECEIVED` | BANK/CASH | INTEREST_RECEIVABLE, LOAN_RECEIVABLE, PENALTY_INCOME, FEE_INCOME (per allocation) |
| `INTEREST_PAYABLE_ACCRUED` (only if the company is allowed to owe interest, L-08) | INTEREST_EXPENSE | INTEREST_PAYABLE |

### 6.6 Cut-over and historical balances
* Posting starts at a per-company **ledger cut-over date** (D-19). Before it, nothing is back-posted automatically.
* Opening balances at cut-over are entered as one approved opening journal entry (manager prepares, approver approves).
* Existing manual journal entries and current balances are left untouched.

### 6.7 Hard-coded figures to replace (E8/E9) — after cut-over only
| Endpoint | Current | Replacement |
|---|---|---|
| `GET /accounting/cashbook` | opening balance constant ₹50,000 | CASH account balance at period start (ledger) |
| `GET /accounting/bankbook` | opening ₹2,50,000; balance split 70/30 into fictional HDFC/SBI accounts | BANK role accounts' ledger balances |
| `GET /accounting/financial-statements` | late fees ₹12,500; cash ₹74,500; bank ₹3,85,000; receivables ₹1,42,000; prize payable ₹95,000 | P&L and balance sheet from ledger by account type |
| `GET /accounting/reports` | `totalArrears = 0`, `computedLateFees = 0`; trial balance from `abs(currentBalance)` | arrears from `MemberDue`; penalties from ledger; trial balance from lines |
| `GET /subscribers/outstanding` | display-only 2 % late fee; includes future instalments | dues engine (§3.5, §3.8) |
| Super-admin financial periods / compliance | in-memory / static | persisted `FinancialPeriod` with posting lock (D-20) |
Until replaced, these responses should carry `"dataSource": "SAMPLE"` so the UI can label them (D-20).

---

## 7. Indian legal and regulatory considerations (identification only — **validate with counsel**)

Nothing below is a compliance rule to implement as-is; each item is an open validation (`OPEN_DECISIONS.md` §3).

**Model A (chit funds)**
* The Chit Funds Act, 1982 and the **chit fund rules of each State** where the company operates (and any State-specific chit legislation that may apply) — registration/sanction of each chit before commencement, security deposit by the foreman, contents of the chit agreement (chit amount, instalments, commission, discount limits, dividend), conduct of auctions/draws (place, time, minimum attendance, minutes, signatures, filing with the Registrar), treatment of prized/non-prized defaulters, substitution of subscribers, unclaimed amounts, books, returns and audits. (L-01..L-06)
* Commonly cited statutory ceilings on foreman's commission and on bid discount exist; the exact limits and any State variations must be confirmed and then entered in the company **legal limit profile** by a super admin — never hard-coded from these documents. (L-01, L-02)
* Whether auctions may be conducted **online / with remote participation**, and what records (e.g. electronic minutes, attendance) are acceptable, depends on the applicable State rules and Registrar practice. (L-05)
* Prize Chits and Money Circulation Schemes (Banning) Act, 1978 — variations that fall outside the Chit Funds Act framework may be prohibited. (L-06)
* Banning of Unregulated Deposit Schemes Act, 2019 — accepting money outside the regulated chit structure (e.g. advance deposits earning returns) needs validation. (L-08)
* Tax: GST on foreman's commission/fees and any TDS implications must be confirmed by a chartered accountant. (L-11)

**Model B (interest-based)**
* Lending as a business may require RBI registration as an NBFC (RBI Act, 1934, s.45-IA) or a licence under the relevant **State Money-Lenders Act**; some States cap interest rates and prescribe registers/receipts. (L-07)
* Usurious Loans Act, 1918 and State laws on excessive interest. (L-07)
* If the operator is an RBI-regulated entity: fair practices code, Key Fact Statement / all-in cost disclosure, penal-charges directions (including restrictions on capitalising penal charges), digital lending guidelines where applicable. (L-09)
* Whether a chit company/foreman may lend to subscribers or accept deposits at all. (L-08)

**Cross-cutting**
* KYC/AML (PMLA), Aadhaar handling restrictions (the app currently stores full `aadhaarNo` in plain text on `User` and `Subscriber`), Digital Personal Data Protection Act, 2023 (consent, purpose limitation, retention), record-retention periods, electronic records and signatures (IT Act, 2000). (L-13, L-14)
