# ChitKart 2.0 — API Design

Status: **DRAFT — no endpoint is implemented.** Labels: [EXISTING] · [PROPOSED] · [DECISION D-xx].

---

## 1. Conventions (inherited from the existing API)

[EXISTING] and kept:
* Base path `/api/v1` (the router is also mounted at `/v1`, `/api`, `/` — kept for compatibility).
* Auth: `Authorization: Bearer <accessToken>`; `authenticateToken` loads role and company from the database; single active session per user; `requireRoles(...)`.
* Envelope: `{ "success": true, "data": … }` / `{ "success": false, "message": "…" }`; money as JSON numbers with ≤ 2 decimals; safe errors via `sendError` (no DB internals).
* Tenant isolation: company from `req.user`, super admin may pass `?companyId=` for reads and must pass it for writes (`requireWriteCompanyId`); cross-company IDs return **404**.
* Rate limiting via `express-rate-limit`; Helmet; CORS allow-list.

[PROPOSED] additions:
* **Idempotency:** every financial mutation accepts `Idempotency-Key` (UUID). The key + route + user is stored (unique); a replay returns the original response. Bids use `clientRequestId` in the body for the same purpose.
* **Optimistic concurrency** for manager edits: `If-Match: <rowVersion>` on configuration and session updates → `409 VERSION_CONFLICT` if stale.
* **Error codes:** `{ success:false, code, message, details? }` with stable codes (`NOT_ELIGIBLE`, `BID_TOO_LOW`, `AUCTION_CLOSED`, `CONFIG_LOCKED`, `LIMIT_EXCEEDED`, `APPROVAL_REQUIRED`, `ALREADY_SETTLED`, `VERSION_CONFLICT`, `DUPLICATE_REQUEST`). Existing endpoints keep their messages.
* **Validation:** `zod` schemas (dependency already present) per request body.
* **Money in requests:** strings or numbers accepted, parsed to decimal on the server; responses keep numbers (existing contract) and additionally expose `"amountText": "1234.50"` in calculation breakdowns for exact display.
* New role `MEMBER` (D-02) — endpoints marked *member* require it and are always scoped to the member's own subscriber record.

Authorization legend: **SA** super admin · **M** manager · **A** approver (manager with approval right, D-14) · **S** collection staff · **MB** member.

---

## 2. Configuration

| Method & path | Roles | Description |
|---|---|---|
| `GET /policy-templates` | M, SA | Built-in templates (each flagged `legallyValidated: false`). |
| `GET /financial-policies/effective?groupId=&sessionId=` | M, A, S(read-only subset) | Resolved configuration with per-field source (`COMPANY`/`GROUP`/`AUCTION`/`LEGAL_LIMIT`). |
| `GET /financial-policies?scope=&groupId=&kind=` | M, A | Version history. |
| `POST /financial-policies` | M (SA for `LEGAL_LIMITS`) | Create a DRAFT version for one `kind` at one scope. |
| `POST /financial-policies/:id/validate` | M | Dry-run validation against legal limits and dependent settings; returns worked example with the group's numbers. |
| `POST /financial-policies/:id/activate` | M or A (D-14) | Activates (updates `PolicyPointer`); locked auctions unaffected. |
| `POST /financial-policies/:id/reject` | A | |

Example — create group commission/dividend policy:
```http
POST /api/v1/financial-policies
Idempotency-Key: 6f1d…
{ "scope": "GROUP", "groupId": "g_123", "kind": "CHIT_ECONOMICS", "schemaVersion": 1,
  "values": { "commission": { "basis": "CHIT_VALUE", "rate": "5.00", "source": "FROM_DISCOUNT" },
              "discount":   { "min": { "type": "AMOUNT", "value": "0" }, "max": { "type": "PERCENT_OF_CHIT", "value": "30" } },
              "dividend":   { "divisor": "ENROLLED_TICKETS", "timing": "NEXT_PERIOD_CREDIT", "remainder": "ROUNDING_RESERVE" } },
  "reason": "Group launch" }
→ 201 { "success": true, "data": { "id": "pv_…", "version": 1, "status": "DRAFT",
        "warnings": [ { "code": "NOT_LEGALLY_VALIDATED", "message": "Limits not validated for your State." } ] } }
→ 422 { "success": false, "code": "LIMIT_EXCEEDED", "message": "Maximum discount 30% exceeds the company legal limit of 25%." }
```

---

## 3. Scheduling

| Method & path | Roles | Description |
|---|---|---|
| `POST /chit-groups/:groupId/auction-schedules` | M | Create schedule (frequency, interval, weekdays/month days/explicit dates, times, timezone, holiday policy). |
| `GET /chit-groups/:groupId/auction-schedules` | M, A, S | List (staff: assigned groups only). |
| `GET /auction-schedules/:id/preview?count=12` | M | Dry run: next occurrences after holidays/exceptions; no writes. |
| `PATCH /auction-schedules/:id` | M | Creates a new schedule version; affects only not-yet-locked occurrences. |
| `POST /auction-schedules/:id/pause` · `/resume` | M | |
| `POST /auction-sessions/:id/postpone` | M | `{ newOpensAt, newClosesAt, reason }` — keeps `occurrenceKey`. |
| `POST /auction-sessions/:id/cancel` | M | `{ reason }`; voids bids (kept). Not allowed after settlement. |
| `GET /auction-calendar?from=&to=&groupId=` | M, A, S, MB | Calendar view (members: only groups they hold tickets in). |
| `POST /holiday-calendars`, `POST /holiday-calendars/:id/holidays` | M | Company holidays. |
| `POST /internal/scheduler/materialize` | system (secret header, D-34) | Idempotent occurrence generation; callable by cron (Vercel Cron, Render cron, or pg_cron). |

---

## 4. Auction sessions (shared by offline and online modes)

| Method & path | Roles | Description |
|---|---|---|
| `GET /auction-sessions?status=&groupId=&from=&to=` | M, A, S, MB | List (scoped). |
| `GET /auction-sessions/:id` | M, A, S, MB | Detail; members see public fields + own eligibility. |
| `POST /auction-sessions` | M | Ad-hoc session (no schedule), e.g. migrated legacy groups. |
| `POST /auction-sessions/:id/open` | M (or scheduler) | Lock point: creates `ConfigSnapshot`, evaluates eligibility, status `OPEN`. |
| `POST /auction-sessions/:id/close` | M (or scheduler / closing rule) | Status `CLOSED`, determines provisional winner (online) or awaits result (offline). |
| `GET /auction-sessions/:id/eligibility` | M, A, S | All decisions with reasons. |
| `GET /auction-sessions/:id/eligibility/me` | MB | Own decision in plain language. |
| `POST /auction-sessions/:id/eligibility/:memberId/override` | M (A if configured) | Only for rules marked overridable; reason required. |
| `POST /auction-sessions/:id/preview` | M, A | Side-effect-free calculation for `{ winnerMemberId, winningDiscount, deductions[] }` → full breakdown. |
| `POST /auction-sessions/:id/offline-result` | M | Records result (+ attendance, minutes, attachments) → `PENDING_APPROVAL` or ready to settle. |
| `POST /auction-sessions/:id/submit` | M | Submit for approval (maker). |
| `POST /auction-sessions/:id/approve` · `/reject` | A | Checker; cannot be the same user as maker when maker–checker is on. |
| `POST /auction-sessions/:id/settle` | M or A | Atomic settlement (idempotent; `Idempotency-Key` required). |
| `POST /auction-sessions/:id/reverse-settlement` | M → A | Creates `SETTLEMENT_REVERSAL` adjustment; executes after approval. |
| `GET /auction-sessions/:id/calculation-runs` | M, A | Stored runs with inputs/outputs/breakdown. |

Preview response (abridged):
```json
{ "success": true, "data": {
  "engineVersion": "1.0.0", "configSnapshotHash": "sha256:9c1…",
  "inputs":  { "chitValue": 100000, "ticketCount": 10, "winningDiscount": 15000, "winnerTicket": 4 },
  "result":  { "commission": 5000, "dividendPool": 10000, "dividendPerTicket": 1000, "remainder": 0,
               "grossPrize": 85000, "deductions": [ { "type": "OVERDUE_DUES", "amount": 9000 } ], "netPrize": 76000,
               "nextPeriodDuePerTicket": 9000 },
  "breakdown": [
    { "step": "commission", "formula": "chitValue × 5% (basis CHIT_VALUE)", "unrounded": "5000", "rounding": "HALF_UP_PAISE", "result": "5000.00" },
    { "step": "dividendPool", "formula": "max(0, discount − commission)", "result": "10000.00" },
    { "step": "dividendPerTicket", "formula": "dividendPool ÷ 10 enrolled tickets", "unrounded": "1000", "rounding": "DOWN_PAISE", "result": "1000.00", "remainder": "0.00" }
  ],
  "explanation": "The winner gives up ₹15,000. ₹5,000 is the foreman's commission and ₹10,000 is shared: ₹1,000 per ticket, credited against next month's contribution." } }
```

### Legacy compatibility [EXISTING endpoint kept]
`POST /auctions/confirm` and `GET /auctions/group/:groupId` stay. For engine-enabled groups `POST /auctions/confirm` is internally translated to *create ad-hoc session → offline-result → settle* with the same response shape, so the existing manager screen keeps working (after fixing defect E1, field `winnerSubscriberId`).

---

## 5. Online bidding

| Method & path | Roles | Description |
|---|---|---|
| `POST /auction-sessions/:id/join` | MB (S/M proxy if D-16 allows) | Registers participation; requires an eligible decision. |
| `POST /auction-sessions/:id/bids` | MB (proxy per D-16) | Place a bid. |
| `GET /auction-sessions/:id/bids?afterSeq=` | M, A; MB (per visibility D-12) | Bid history / resync. |
| `GET /auction-sessions/:id/state` | all participants | Snapshot: status, server time, closesAt/extendedUntil, best bid (if open auction), lastEventSeq. |
| `POST /realtime/tickets` | authenticated | Short-lived (60 s) single-use ticket for the WebSocket/SSE connection (browsers cannot set headers on WebSocket). |

Bid request/response:
```http
POST /api/v1/auction-sessions/as_42/bids
{ "clientRequestId": "b7f0c6e2-…", "discount": "18500.00" }

201 { "success": true, "data": { "status": "ACCEPTED", "sequenceNo": 17, "discount": 18500,
      "isBest": true, "serverTime": "2026-11-07T05:41:12.381Z", "closesAt": "2026-11-07T05:45:00Z" } }
200 (replay of same clientRequestId) → identical body
409 { "success": false, "code": "BID_TOO_LOW", "message": "Bid must be at least ₹18,600 (current best ₹18,500 + step ₹100)." }
409 { "code": "AUCTION_CLOSED" } · 403 { "code": "NOT_ELIGIBLE", "message": "₹9,000 overdue since 05-11-2026." }
429 { "code": "RATE_LIMITED" }
```

Server-side bid algorithm (single transaction):
1. `SELECT … FROM "AuctionSession" WHERE id = $1 AND "companyId" = $2 FOR UPDATE` (serializes all bids of one auction).
2. Reject if `status ≠ OPEN` or `now() ≥ coalesce(extendedUntil, closesAt)` (database clock is authoritative).
3. Load participant + latest eligibility decision; reject if not eligible.
4. Validate `Dmin ≤ discount ≤ Dmax`, step multiple, `discount ≥ best + step` (open ascending auction) — for sealed mode only bounds (D-12).
5. If `(sessionId, participantId, clientRequestId)` exists → return stored result (idempotent).
6. `sequenceNo = lastEventSeq + 1`; insert bid; update `bestBidId`, `lastEventSeq`; apply anti-sniping (`extendedUntil = max(current, now + extension)` within `maxExtension`).
7. Commit, then publish `bid.accepted` (and `auction.extended`) via `NOTIFY auction_<id>`; rejected bids are stored with reason (audit) but not broadcast.

---

## 6. Real-time communication

### Constraint from the current architecture
* The web app and API are deployed together on **Vercel** (`vercel.json`: `api/index.js` serverless function). Serverless functions cannot hold WebSocket connections and long-lived SSE streams are limited by function timeouts.
* The API can also run as a long-lived Node process (`backend/Dockerfile`, Render guide).

### Options evaluated
| Option | Fit | Notes |
|---|---|---|
| **WebSocket (`ws`/Socket.IO) on a long-running Node service** | ✔ recommended for online auctions | Needs Render/Fly/VM hosting for the realtime service (or the whole API). Fan-out across instances via PostgreSQL `LISTEN/NOTIFY` (no new infrastructure) or Redis later. |
| Server-Sent Events | ✔ acceptable | Simpler (one-way push; bids still via REST); same hosting constraint; auto-reconnect with `Last-Event-ID` = `lastEventSeq`. |
| Short polling (`GET /state` + `GET /bids?afterSeq=`) every 2–3 s | ✔ fallback | Works on Vercel today; higher latency/load; always kept as fallback. |
| Supabase Realtime | ✘ for now | Requires Supabase Auth + RLS policies exposing tables to clients; current design keeps all tables locked (RLS deny-all) and authenticates via the API's own JWT. |
| Third-party (Pusher/Ably) | possible | New vendor, cost, data residency review. |

**Recommendation (D-33):** REST for every mutation (bids included, so validation stays in one place); push via **SSE or WebSocket from a small long-running "realtime" process** that subscribes to PostgreSQL `NOTIFY`; clients fall back to polling automatically. Offline auctions need none of this.

### Event protocol
```json
{ "seq": 18, "type": "bid.accepted", "sessionId": "as_42", "serverTime": "…",
  "data": { "sequenceNo": 17, "discount": 18500, "bidder": "Ticket #4" } }
```
Types: `auction.state` (on connect), `auction.opened`, `bid.accepted`, `auction.extended`, `auction.closing_soon`, `auction.closed`, `auction.result`, `auction.cancelled`, `heartbeat` (every 15 s). Bidder identity in broadcasts is masked to ticket numbers (privacy, D-12). On reconnect the client sends `lastSeq`; the server replays missing events from `AuctionBid`/session history or the client calls `GET /state`.

---

## 7. Dues, payments and staff operations

| Method & path | Roles | Description |
|---|---|---|
| `GET /chit-groups/:groupId/dues?period=&status=` | M, A, S (assigned) | Per-ticket dues (`MemberDue`). |
| `GET /collections/worklist?date=` | S | Today's collection list for assigned groups with revised (post-dividend) amounts and overdue. |
| `POST /collections/pay` [EXISTING] | M, S | Extended: optional `allocations[]`; default allocation per waterfall (D-23). Response unchanged + `allocations`. |
| `POST /dues/:id/penalties/:penaltyId/waive` | M → A | Creates `PENALTY_WAIVER` adjustment. |
| `POST /financial-adjustments` · `/:id/approve` · `/:id/reject` | M (maker), A (checker) | All corrections. |

## 8. Interest engine (Model B — gated by D-25/L-07)

| Method & path | Roles | Description |
|---|---|---|
| `POST /interest/quote` | M | Side-effect-free schedule/EMI quote with breakdown and effective rate disclosure. |
| `POST /interest-accounts` | M | Draft account (product policy + principal + dates). |
| `POST /interest-accounts/:id/activate` | M → A | Lock snapshot, create schedule, post disbursement. |
| `GET /interest-accounts/:id` · `/schedule` · `/accruals` · `/statement` | M, A, S (collection), MB (own) | |
| `POST /interest-accounts/:id/repayments` | M, S | Payment with waterfall allocation (idempotent). |
| `POST /interest-accounts/:id/prepayment-quote` · `/prepay` | M | `REDUCE_EMI` / `REDUCE_TENURE`. |
| `POST /interest-accounts/:id/rate-changes` | M → A | Variable-rate change with effective date. |
| `POST /internal/interest/accrue?asOf=` | system | Idempotent accrual job (unique per account/kind/period). |

## 9. Accounting

| Method & path | Roles | Description |
|---|---|---|
| `GET /accounting/account-mappings` · `PUT` | M | Role → account mapping (validated: type compatibility). |
| `POST /accounting/cutover` | M → A | Set ledger cut-over date + opening balance entry. |
| `GET /financial-events?type=&sourceType=&sourceId=` | M, A | Event ↔ journal entry trace. |
| `GET /journal-entries/:id/source` | M, A | Reverse lookup. |
| `GET /accounting/financial-statements` [EXISTING] | M | After cut-over: ledger-based; before: adds `"dataSource": "SAMPLE"` (D-20). |

## 10. Member portal (requires D-02)

| Method & path | Description |
|---|---|
| `GET /me/tickets` | Tickets, groups, prized status. |
| `GET /me/dues` · `/me/payments` · `/me/dividends` | Own history. |
| `GET /me/statements/:groupId` | Statement (PDF later). |
| `GET /me/auctions?status=upcoming` | Eligible upcoming auctions with own eligibility. |
| `GET /me/interest-accounts` | Only if Model B is enabled. |

## 11. Security requirements for all new endpoints
* Company scoping through `src/security/tenant.ts` helpers; new loaders (`loadSessionForTenant`, `loadPolicyForTenant`, …) return 404 across companies.
* Role checks via `requireRoles`; approver right checked per action; maker ≠ checker.
* Members can act only on their own tickets; staff only on assigned groups (existing `staffGroupIds`).
* Rate limits: bids 10/10 s per participant, join 5/min, previews 30/min, settlement 10/min per company.
* Every mutation writes `AuditLog` (existing) with before/after where applicable.
* Tests listed in `IMPLEMENTATION_ROADMAP.md` §4 (cross-company access, unauthorized configuration, duplicate settlement, concurrent bids).
