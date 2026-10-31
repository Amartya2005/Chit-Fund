# ChitKart 2.0 — Database Design

Status: **DRAFT — no migration has been created or applied.** Labels: [EXISTING] · [PROPOSED] · [DECISION D-xx].
Baseline: Prisma schema at `4d6daa8` (27 tables, 4 migrations; money `NUMERIC(15,2)`; RLS enabled on all tables; `CompanySequence` for atomic numbering).

---

## 1. Design principles

1. **Additive only.** New tables and nullable columns; no destructive change to existing tables or data. Existing endpoints keep working on legacy groups.
2. **Tenant key on every row.** Every new table carries `companyId` (even when derivable through a parent) so that every query can be filtered by company and indexed by it. All composite uniques start with the owning scope.
3. **Append-only financial history.** Configuration versions, snapshots, bids, eligibility decisions, calculation runs, settlements, financial events and journal entries are never updated after their terminal state; corrections create new rows (`reversalOfId`, `supersedesId`).
4. **Uniqueness in the database, not only in code** — every idempotency requirement maps to a unique index.
5. **Money** `NUMERIC(15,2)`; **rates** `NUMERIC(9,6)`; **unrounded accruals** `NUMERIC(24,10)`; **business dates** `DATE` (new tables; existing tables keep `YYYY-MM-DD` strings, D-21); **instants** `TIMESTAMPTZ(3)`.
6. **Enumerations.** New status/type columns use PostgreSQL enums via Prisma `enum` (existing tables keep strings; D-29).
7. **Non-negative checks.** `CHECK (amount >= 0)` etc. added in raw SQL inside migrations (Prisma ignores CHECK constraints, so they do not cause schema drift).
8. **RLS.** Every new table gets `ENABLE ROW LEVEL SECURITY` in its migration (same pattern as `20261031000100_enable_rls`).

---

## 2. Reuse of existing models

| Existing model | Reuse |
|---|---|
| `Company`, `User`, `Subscriber`, `ChitGroup`, `ChitGroupMember` | Unchanged identity; new nullable columns listed in §9. |
| `Auction` | Becomes the **settled result** record (kept for legacy endpoints, payouts and reports). New lifecycle lives in `AuctionSession`, which links to the `Auction` row created on settlement. |
| `AuctionBid` | Currently unused (no writer). Extended for online bids (nullable `sessionId`, sequence, idempotency); `auctionId` becomes nullable (D-30). |
| `Payout` | Reused for prize payouts (1:1 with `Auction`). |
| `InstallmentSchedule` | Kept for legacy groups and as the *group-level* calendar view; per-ticket obligations move to `MemberDue`. |
| `PaymentTransaction`, `Receipt` | Reused; allocation to dues via new `PaymentAllocation`. |
| `Refund` | Reused for surrenders. |
| `Account`, `JournalEntry`, `JournalEntryLine` | Reused; extended with source/reversal links and dimensions. |
| `AuditLog`, `Notification`, `CompanySequence` | Reused as-is. |

---

## 3. Configuration

```prisma
enum PolicyScope   { COMPANY GROUP AUCTION }
enum PolicyKind    { CHIT_ECONOMICS AUCTION_RULES BIDDING DIVIDEND CONTRIBUTION PENALTY DEFAULT_HANDLING
                     ELIGIBILITY SETTLEMENT SCHEDULING ROUNDING INTEREST_PRODUCT LEGAL_LIMITS }
enum PolicyStatus  { DRAFT ACTIVE SUPERSEDED REJECTED }

model FinancialPolicyVersion {            // one immutable version of one policy document
  id             String       @id @default(uuid())
  companyId      String
  scope          PolicyScope
  scopeKey       String                    // "COMPANY" | "GROUP:<groupId>" | "AUCTION:<sessionId>" (never NULL)
  groupId        String?                   // set when scope = GROUP (FK, for joins)
  auctionSessionId String?                 // set when scope = AUCTION (FK, for joins)
  kind           PolicyKind
  version        Int                       // 1, 2, 3… per (scopeKey, kind)
  schemaVersion  Int                       // version of the JSON schema used to validate `values`
  values         Json                      // validated with zod per (kind, schemaVersion)
  status         PolicyStatus @default(DRAFT)
  reason         String?
  createdById    String
  approvedById   String?
  createdAt      DateTime     @default(now())
  activatedAt    DateTime?
  @@unique([companyId, scopeKey, kind, version])   // scopeKey is non-null on purpose (see note below)
  @@index([companyId, kind, status])
}

model PolicyPointer {                      // "which version is active" — one row per target+kind
  companyId  String
  scopeKey   String                         // "COMPANY" | "GROUP:<groupId>" | "AUCTION:<sessionId>"
  kind       PolicyKind
  versionId  String  @unique
  updatedAt  DateTime @updatedAt
  @@id([companyId, scopeKey, kind])
}

model ConfigSnapshot {                     // resolved, frozen configuration at the lock point
  id             String   @id @default(uuid())
  companyId      String
  subjectType    String                     // "AUCTION_SESSION" | "INTEREST_ACCOUNT" | "GROUP_ACTIVATION"
  subjectId      String
  resolved       Json                       // fully merged config (all kinds) incl. legal limits
  sources        Json                       // per field: { level, policyVersionId }
  engineVersion  String
  hash           String                     // sha256 of canonical JSON of `resolved`
  lockedAt       DateTime @default(now())
  lockedById     String?
  @@unique([subjectType, subjectId])        // exactly one snapshot per subject
  @@index([companyId, lockedAt])
}
```
**NULLs in unique keys:** PostgreSQL treats NULLs as distinct, so a unique index that includes a nullable column does not prevent duplicates when that column is NULL (Prisma cannot declare `NULLS NOT DISTINCT`). Every idempotency key in this design therefore uses non-null columns (e.g. `scopeKey` above), or is paired with a raw-SQL `CHECK` that makes the column non-null for the rows that need the guarantee (e.g. `CHECK (sessionId IS NULL OR (clientRequestId IS NOT NULL AND sequenceNo IS NOT NULL))` on `AuctionBid`).

Why `PolicyPointer` instead of a partial unique index: Prisma cannot express partial indexes, and a hand-written partial index would be reported as drift by `prisma migrate dev`. A pointer table gives a normal unique key and makes activation a single atomic upsert.

Resolution order: `LEGAL_LIMITS` (company, super admin) bound everything → COMPANY → GROUP → AUCTION (whitelisted keys only). Values outside legal limits are rejected at save time and re-checked at snapshot time.

---

## 4. Scheduling and contribution calendar

```prisma
enum ScheduleFrequency { DAILY WEEKLY MONTHLY_BY_DAY MONTHLY_BY_WEEKDAY EVERY_N_DAYS EXPLICIT_DATES }
enum HolidayPolicy     { SKIP NEXT_BUSINESS_DAY PREVIOUS_BUSINESS_DAY IGNORE }
enum ScheduleStatus    { ACTIVE PAUSED ENDED }

model AuctionSchedule {
  id              String            @id @default(uuid())
  companyId       String
  groupId         String
  version         Int               @default(1)      // edits create a new version; old occurrences keep theirs
  frequency       ScheduleFrequency
  interval        Int               @default(1)      // every n weeks / days / months
  byWeekdays      Int[]                              // 1=Mon … 7=Sun
  byMonthDays     Int[]                              // 1..31, -1 = last day
  byWeekdayOrdinal Int?                              // e.g. 2 (= second) for MONTHLY_BY_WEEKDAY
  explicitDates   DateTime[]        @db.Date
  timezone        String            @default("Asia/Kolkata")
  startDate       DateTime          @db.Date
  endDate         DateTime?         @db.Date
  maxOccurrences  Int?
  opensAtLocal    String                              // "HH:mm"
  closesAtLocal   String                              // "HH:mm"
  holidayCalendarId String?
  holidayPolicy   HolidayPolicy     @default(NEXT_BUSINESS_DAY)
  status          ScheduleStatus    @default(ACTIVE)
  generatedUntil  DateTime?         @db.Date          // materialization watermark
  createdById     String
  createdAt       DateTime          @default(now())
  @@index([companyId, status])
  @@index([groupId])
}

model ScheduleException {                 // skip / postpone / reschedule a specific occurrence
  id            String   @id @default(uuid())
  companyId     String
  scheduleId    String
  occurrenceKey DateTime @db.Date           // the ORIGINAL planned date (stable identity)
  action        String                      // SKIP | MOVE
  newOpensAt    DateTime?                   // for MOVE
  newClosesAt   DateTime?
  reason        String
  createdById   String
  createdAt     DateTime @default(now())
  @@unique([scheduleId, occurrenceKey])
}

model HolidayCalendar { id String @id @default(uuid()); companyId String; name String; @@unique([companyId, name]) }
model Holiday         { id String @id @default(uuid()); companyId String; calendarId String; date DateTime @db.Date; name String
                        @@unique([calendarId, date]) }

model ContributionSchedule {               // independent of auction frequency (D-06)
  id          String   @id @default(uuid())
  companyId   String
  groupId     String   @unique
  frequency   ScheduleFrequency
  interval    Int      @default(1)
  byWeekdays  Int[]
  byMonthDays Int[]
  periods     Int                            // number of contribution periods
  firstDueDate DateTime @db.Date
  graceDays   Int      @default(0)
  timezone    String   @default("Asia/Kolkata")
}

model ContributionPeriod {
  id         String   @id @default(uuid())
  companyId  String
  groupId    String
  periodNo   Int
  dueDate    DateTime @db.Date
  baseAmount Decimal  @db.Decimal(15, 2)       // I_k
  @@unique([groupId, periodNo])
  @@index([companyId, dueDate])
}

enum DueStatus { UPCOMING DUE PARTIALLY_PAID PAID OVERDUE DEFAULTED WAIVED }

model MemberDue {                          // per ticket per period obligation (fixes E7)
  id             String    @id @default(uuid())
  companyId      String
  groupId        String
  memberId       String                       // ChitGroupMember.id (ticket)
  subscriberId   String
  periodNo       Int
  dueDate        DateTime  @db.Date
  grossAmount    Decimal   @db.Decimal(15, 2)
  dividendCredit Decimal   @db.Decimal(15, 2) @default(0)
  penaltyAmount  Decimal   @db.Decimal(15, 2) @default(0)
  netAmount      Decimal   @db.Decimal(15, 2)
  paidAmount     Decimal   @db.Decimal(15, 2) @default(0)
  status         DueStatus @default(UPCOMING)
  updatedAt      DateTime  @updatedAt
  @@unique([memberId, periodNo])
  @@index([companyId, groupId, dueDate])
  @@index([subscriberId, status])
}
// CHECKs: netAmount = grossAmount - dividendCredit + penaltyAmount; 0 <= paidAmount <= netAmount (+ advance handled separately)

model PaymentAllocation {
  id            String   @id @default(uuid())
  companyId     String
  paymentId     String                         // PaymentTransaction.id
  dueId         String?                        // MemberDue.id (null = advance bucket)
  bucket        String                         // PENALTY | CONTRIBUTION | ADVANCE
  amount        Decimal  @db.Decimal(15, 2)
  reversedById  String?  @unique
  createdAt     DateTime @default(now())
  @@index([paymentId])
  @@index([dueId])
}
```

### Occurrence materialization (idempotency)
* A materializer computes occurrences up to a horizon (e.g. 60 days) and inserts `AuctionSession` rows with `INSERT … ON CONFLICT (scheduleId, occurrenceKey) DO NOTHING`.
* `occurrenceKey` is the originally planned date and never changes; postponement changes `opensAt/closesAt`, not the key.
* Runs are serialized per schedule with `pg_advisory_xact_lock(hashtext(scheduleId))` or `SELECT … FOR UPDATE SKIP LOCKED` on `AuctionSchedule`; even without the lock, the unique key makes duplicates impossible.
* `generatedUntil` watermark is advanced in the same transaction.

---

## 5. Auction lifecycle, bidding, eligibility, calculation

```prisma
enum AuctionMode   { OFFLINE ONLINE HYBRID }
enum SessionStatus { SCHEDULED OPEN CLOSED PENDING_APPROVAL SETTLED POSTPONED CANCELLED NO_BID }

model AuctionSession {
  id               String        @id @default(uuid())
  companyId        String
  groupId          String
  scheduleId       String?                      // null for ad-hoc / legacy-converted sessions
  occurrenceKey    DateTime?     @db.Date
  sequenceNo       Int                          // auction number within the group (1..N)
  targetPeriodNo   Int?                         // contribution period receiving the dividend (D-06/D-07)
  mode             AuctionMode
  status           SessionStatus @default(SCHEDULED)
  opensAt          DateTime
  closesAt         DateTime
  extendedUntil    DateTime?                    // anti-sniping extension
  configSnapshotId String?       @unique        // set at lock point
  bestBidId        String?                      // denormalized current best (online)
  lastEventSeq     Int           @default(0)    // realtime resync cursor
  resultAuctionId  String?       @unique        // existing Auction row created at settlement
  cancelReason     String?
  rowVersion       Int           @default(0)    // optimistic concurrency for manager actions
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt
  @@unique([scheduleId, occurrenceKey])        // idempotent materialization
  @@unique([groupId, sequenceNo])
  @@index([companyId, status, opensAt])
}

model AuctionParticipant {
  id                String   @id @default(uuid())
  companyId         String
  sessionId         String
  memberId          String                       // ticket
  subscriberId      String
  eligibilityId     String                       // EligibilityDecision used at join time
  joinedAt          DateTime @default(now())
  attendance        String?                      // PRESENT | REMOTE | PROXY (D-17)
  @@unique([sessionId, memberId])
}

// Existing table, extended (D-30):
model AuctionBid {
  id              String    @id @default(uuid())
  auctionId       String?                         // existing column, made nullable
  sessionId       String?                         // NEW
  companyId       String?                         // NEW (backfilled; required for new rows)
  participantId   String?                         // NEW
  subscriberId    String
  bidDiscount     Decimal   @db.Decimal(15, 2)
  bidTime         DateTime  @default(now())
  sequenceNo      Int?                            // NEW: per-session order
  clientRequestId String?                         // NEW: idempotency key from the client
  status          String?                         // NEW: ACCEPTED | REJECTED | VOIDED
  rejectReason    String?
  source          String?                         // ONLINE | MANAGER_ENTERED | PROXY
  placedByUserId  String?
  @@unique([sessionId, sequenceNo])
  @@unique([sessionId, participantId, clientRequestId])
  @@index([sessionId, bidTime])
}

model EligibilityDecision {
  id            String   @id @default(uuid())
  companyId     String
  sessionId     String
  memberId      String
  eligible      Boolean
  reasons       Json                             // [{ rule, passed, inputs, message }]
  snapshotHash  String
  evaluatedAt   DateTime @default(now())
  overriddenById String?
  overrideReason String?
  @@index([sessionId, memberId])
}

model CalculationRun {                        // reproducibility record
  id             String   @id @default(uuid())
  companyId      String
  engine         String                         // CHIT | INTEREST
  kind           String                         // AUCTION_SETTLEMENT | DUE_REVISION | ACCRUAL | SCHEDULE | PREVIEW…
  engineVersion  String
  configSnapshotId String?
  inputs         Json
  outputs        Json
  breakdown      Json
  inputHash      String
  outputHash     String
  createdById    String?
  createdAt      DateTime @default(now())
  @@index([companyId, kind, createdAt])
}

enum SettlementStatus { PENDING_APPROVAL SETTLED REVERSED }

model AuctionSettlement {
  id               String           @id @default(uuid())
  companyId        String
  sessionId        String
  revision         Int              @default(1)       // re-settlement after a reversal = revision 2
  calculationRunId String           @unique
  winnerMemberId   String
  winningDiscount  Decimal          @db.Decimal(15, 2)
  commission       Decimal          @db.Decimal(15, 2)
  dividendPool     Decimal          @db.Decimal(15, 2)
  dividendPerTicket Decimal         @db.Decimal(15, 2)
  remainder        Decimal          @db.Decimal(15, 2)
  grossPrize       Decimal          @db.Decimal(15, 2)
  deductions       Decimal          @db.Decimal(15, 2) @default(0)
  netPrize         Decimal          @db.Decimal(15, 2)
  status           SettlementStatus
  submittedById    String
  approvedById     String?
  settledAt        DateTime?
  reversalOfId     String?          @unique
  @@unique([sessionId, revision])
  @@index([companyId, settledAt])
}

model DividendRecord {
  id            String   @id @default(uuid())
  companyId     String
  settlementId  String
  memberId      String
  subscriberId  String
  amount        Decimal  @db.Decimal(15, 2)
  targetPeriodNo Int?
  appliedDueId  String?
  status        String                           // CREDITED | APPLIED | PAID | REVERSED
  @@unique([settlementId, memberId])
}

model CommissionRecord {
  id           String  @id @default(uuid())
  companyId    String
  settlementId String  @unique
  basis        String
  rate         Decimal @db.Decimal(9, 6)
  amount       Decimal @db.Decimal(15, 2)
  taxAmount    Decimal @db.Decimal(15, 2) @default(0)   // only if L-11 confirms
}

model FinancialAdjustment {                    // maker–checker corrections
  id           String   @id @default(uuid())
  companyId    String
  type         String                          // DUE_WAIVER | PENALTY_WAIVER | WRITE_OFF | SETTLEMENT_REVERSAL | MANUAL
  targetType   String
  targetId     String
  amount       Decimal  @db.Decimal(15, 2)
  reason       String
  status       String                          // REQUESTED | APPROVED | REJECTED | APPLIED
  requestedById String
  approvedById String?
  createdAt    DateTime @default(now())
  appliedAt    DateTime?
  @@index([companyId, status])
}
```

---

## 6. Interest engine (Model B)

```prisma
enum InterestAccountStatus { DRAFT ACTIVE CLOSED WRITTEN_OFF }

model InterestAccount {
  id               String   @id @default(uuid())
  companyId        String
  accountNo        String                         // from CompanySequence "interestAccount"
  subscriberId     String?                        // borrower (D-25)
  linkedMemberId   String?                        // optional link to a ticket (D-25)
  productPolicyId  String                         // INTEREST_PRODUCT policy version
  configSnapshotId String   @unique               // locked at activation
  principal        Decimal  @db.Decimal(15, 2)
  disbursedOn      DateTime? @db.Date
  status           InterestAccountStatus @default(DRAFT)
  @@unique([companyId, accountNo])
}

model RateChange       { id String @id @default(uuid()); companyId String; accountId String; effectiveFrom DateTime @db.Date
                         annualRate Decimal @db.Decimal(9, 6); reason String; createdById String; @@unique([accountId, effectiveFrom]) }

model RepaymentInstallment {
  id           String   @id @default(uuid())
  companyId    String
  accountId    String
  scheduleVersion Int                            // a new version after prepayment / rate change
  installmentNo Int
  dueDate      DateTime @db.Date
  principal    Decimal  @db.Decimal(15, 2)
  interest     Decimal  @db.Decimal(15, 2)
  paidPrincipal Decimal @db.Decimal(15, 2) @default(0)
  paidInterest Decimal  @db.Decimal(15, 2) @default(0)
  status       String                             // UPCOMING | DUE | PAID | OVERDUE | SUPERSEDED
  @@unique([accountId, scheduleVersion, installmentNo])
  @@index([companyId, dueDate])
}

model InterestAccrual {
  id            String   @id @default(uuid())
  companyId     String
  accountId     String
  periodStart   DateTime @db.Date
  periodEnd     DateTime @db.Date                 // exclusive
  kind          String                            // REGULAR | OVERDUE | PENAL
  base          Decimal  @db.Decimal(15, 2)
  annualRate    Decimal  @db.Decimal(9, 6)
  days          Int
  unrounded     Decimal  @db.Decimal(24, 10)
  cumulativeUnrounded Decimal @db.Decimal(24, 10)
  posted        Decimal  @db.Decimal(15, 2)
  calculationRunId String
  @@unique([accountId, kind, periodStart])        // idempotent accrual job
}

model InterestRepayment { id String @id @default(uuid()); companyId String; accountId String; paymentId String @unique
                          amount Decimal @db.Decimal(15, 2); allocation Json; receivedOn DateTime @db.Date }
```

---

## 7. Accounting integration

```prisma
model FinancialEvent {
  id             String   @id @default(uuid())
  companyId      String
  type           String                          // DUE_RAISED, PAYMENT_RECEIVED, AUCTION_SETTLED, …
  sourceType     String
  sourceId       String
  amount         Decimal  @db.Decimal(15, 2)
  payload        Json
  occurredOn     DateTime @db.Date
  idempotencyKey String
  journalEntryId String?  @unique
  reversalOfId   String?  @unique
  createdAt      DateTime @default(now())
  @@unique([companyId, idempotencyKey])           // e.g. "AUCTION_SETTLED:<settlementId>"
  @@index([companyId, type, occurredOn])
  @@index([sourceType, sourceId])
}

model AccountMapping {                          // role -> account per company
  companyId String
  role      String                              // CASH, BANK, SUBSCRIBER_RECEIVABLE, PRIZE_PAYABLE, …
  accountId String
  @@id([companyId, role])
}

model PostingRuleVersion { id String @id @default(uuid()); companyId String?; eventType String; version Int
                           rules Json; activeFrom DateTime; @@unique([companyId, eventType, version]) }
```
Additions to existing tables (nullable, non-breaking):
* `JournalEntry`: `sourceEventId String? @unique`, `reversalOfId String? @unique`, `postedById String?`, `periodId String?`.
* `JournalEntryLine`: `groupId String?`, `subscriberId String?`, `memberId String?` (+ indexes) — dimensions instead of one account per group.
* `Company`: `ledgerCutoverDate DateTime? @db.Date`, `engineEnabled Boolean @default(false)` (replaces the in-memory feature flag for this engine).
* `FinancialPeriod` (new): `companyId, name, startDate, endDate, status OPEN|CLOSED`, posting into a closed period rejected (replaces in-memory periods, D-20).

---

## 8. Constraints and indexes summary

| Concern | Mechanism |
|---|---|
| Duplicate scheduled auctions | `AuctionSession @@unique([scheduleId, occurrenceKey])` (both non-null for scheduled sessions — enforced by `CHECK ((scheduleId IS NULL) = (occurrenceKey IS NULL))`) + `@@unique([groupId, sequenceNo])` (sequence from `CompanySequence` key `auctionSeq:<groupId>`) |
| Double settlement | `AuctionSettlement @@unique([sessionId, revision])` + conditional status transition `UPDATE … WHERE status = 'CLOSED'`; `AuctionSession.resultAuctionId @unique`; existing `Auction @@unique([groupId, installmentNo])` and `Payout.auctionId @unique` |
| Duplicate bid submission | `AuctionBid @@unique([sessionId, participantId, clientRequestId])` |
| Bid ordering | `@@unique([sessionId, sequenceNo])`; sequence assigned under `SELECT … FOR UPDATE` on the session row |
| One win per ticket | checked in the settlement transaction (`COUNT` of settled settlements per member) + `DividendRecord`/`AuctionSettlement` uniqueness; optional DB trigger if D-04 makes it statutory |
| Duplicate accounting | `FinancialEvent @@unique([companyId, idempotencyKey])`, `JournalEntry.sourceEventId @unique` |
| Duplicate accrual | `InterestAccrual @@unique([accountId, kind, periodStart])` |
| One snapshot per subject | `ConfigSnapshot @@unique([subjectType, subjectId])` |
| Negative amounts | raw-SQL `CHECK` constraints in migrations |
| Tenant filtering | `@@index([companyId, …])` on every new table |
| Foreign keys | all `*Id` columns get FKs with `ON DELETE RESTRICT` for financial tables (no cascades that could delete history) |

---

## 9. Changes to existing tables (all additive / nullable)

| Table | Change | Purpose |
|---|---|---|
| `ChitGroup` | `engineVersion String @default("LEGACY")`, `financialModel String?` | opt-in to the new engine per group (D-32) |
| `ChitGroupMember` | `status String @default("ACTIVE")`, `prizedAt DateTime?`, `prizedSessionId String?`, `exitedAt DateTime?` | prized status (fixes E2) and soft exit instead of deletion (fixes E11) |
| `Auction` | `sessionId String? @unique`, `settlementId String?` | link legacy result table to new lifecycle |
| `AuctionBid` | see §5 (`auctionId` nullable) | online bidding |
| `PaymentTransaction` | `allocationStatus String?` | allocation tracking |
| `JournalEntry`, `JournalEntryLine`, `Company` | see §7 | accounting integration |

The surrender flow (`processRefund`) would set `ChitGroupMember.status = 'EXITED'` instead of deleting the row once the engine is enabled for the group (behaviour change for engine groups only).

---

## 10. Migration strategy

1. **M1 Foundations:** enums, policy/snapshot/pointer tables, `Company.engineEnabled`, `ChitGroup.engineVersion`, `ChitGroupMember` status columns, `FinancialPeriod`, `AccountMapping`, RLS. No data changes except column defaults.
2. **M2 Dues & allocation:** `ContributionSchedule/Period`, `MemberDue`, `PaymentAllocation`, CHECK constraints.
3. **M3 Accounting:** `FinancialEvent`, `PostingRuleVersion`, `JournalEntry(Line)` columns.
4. **M4 Auctions:** `AuctionSchedule`, `ScheduleException`, holidays, `AuctionSession`, `AuctionParticipant`, `EligibilityDecision`, `CalculationRun`, `AuctionSettlement`, `DividendRecord`, `CommissionRecord`, `FinancialAdjustment`, `AuctionBid` extension (`ALTER COLUMN auctionId DROP NOT NULL`).
5. **M5 Interest:** Model B tables (only after D-25/L-07 approval).

Rules:
* Each migration is applied to a disposable DB, the test DB and the Supabase dev project first; `prisma migrate diff --exit-code` must be clean (CI already enforces this).
* **No backfill of existing groups by default.** Existing groups stay `engineVersion = LEGACY` and keep using `InstallmentSchedule` + `POST /auctions/confirm`.
* Converting a legacy group to the engine is an explicit, previewed, approved operation per group (D-32): it creates `ContributionPeriod`/`MemberDue` from `InstallmentSchedule` + past `PaymentTransaction`s, marks prized tickets from existing `Auction` rows, and produces a reconciliation report; any mismatch blocks conversion.
* Down-migrations are not used in production; rollback = disable the engine flag (data remains, legacy paths unaffected).
* Prisma cannot express partial indexes or CHECKs; CHECKs live in raw SQL inside the migration files (ignored by drift detection), partial uniqueness is avoided by design (`PolicyPointer`).
