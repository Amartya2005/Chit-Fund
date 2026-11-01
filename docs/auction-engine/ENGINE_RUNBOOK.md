# ChitKart Auction & Financial Engine — Runbook

How the engine (P3–P10, branch `claude/engine-p3-p10`) is switched on and operated. Everything is **off by default**: existing companies and groups keep working exactly as before until each step below is taken explicitly.

## 1. What is switched on, by whom

| Switch | Who | Endpoint | Effect |
|---|---|---|---|
| Engine for a company | Super admin | `PATCH /api/v1/engine/companies/:id/settings { engineEnabled: true }` | Groups of the company *may* be converted. Cannot be switched off while a group runs on the engine. |
| Settings (policies) | Manager (legal limits: super admin) | `/api/v1/financial-policies` | Every business rule is chosen explicitly; nothing is defaulted. A group cannot be converted until its configuration is complete and within the legal limits (`readyForLock`). |
| Convert a group | Manager | `POST /api/v1/engine/groups/:id/convert` (first with `{ dryRun: true }`) | Dues, payments and dividends are carried over from the existing records with an exact reconciliation; the group's configuration is frozen as a snapshot. One-way. |
| Member portal | Super admin (decision D-02) | `PATCH /api/v1/engine/companies/:id/member-portal { enabled }` | Managers can create member logins (`POST /engine/members/:subscriberId/login`). Switching it off locks members out immediately. |
| Accounting posting | Manager | `PUT /engine/accounting/cutover`, `PUT /engine/accounting/mappings` | Events are posted to the ledger only from the cut-over date and only when every role used is mapped. Posting rules need CA review (L-12). |
| Interest engine (Model B) | Super admin, **after legal sign-off** | `PATCH /engine/companies/:id/interest-engine { enabled, attestation }` | Locked otherwise (`INTEREST_ENGINE_LOCKED`). The attestation text is stored and audited. |

## 2. Recommended order for a company

1. Super admin: set the **legal limit profile** (`LEGAL_LIMITS` policy) with values confirmed by counsel (L-01/L-02).
2. Manager: activate company settings for every kind (`GET /financial-policies/effective` lists what is still missing). The template `MONTHLY_CLASSIC` reproduces today's behaviour where today's behaviour exists; it leaves the rest open on purpose.
3. Super admin: enable the engine for the company.
4. Manager: for each group, run the conversion **dry run**, review the report (blocking items, warnings, advance amounts, pending dividend decisions), then convert.
5. Plan auctions (schedule or single dates), or let the scheduler create them.
6. Optional: ledger cut-over + account mapping; member portal; online auctions (`SCHEDULING.mode` ONLINE/HYBRID + `BIDDING` settings).

## 3. Scheduler (cron)

`POST /api/v1/engine/scheduler/cron` with header `X-Cron-Secret: <CRON_SECRET>` (env, ≥ 32 characters) runs, for every company with the engine enabled:
materialise scheduled auctions for the next 60 days (idempotent) → open / close online auctions whose time has come (database clock) → raise due periods and retry unposted accounting events.
Run it every few minutes when online auctions are used (they close only when the scheduler or a manager acts after the closing time), otherwise hourly is enough. Managers can trigger the same run for their company from the app (**Auction Engine → Auctions → Run scheduler now**). Without `CRON_SECRET` the cron endpoint always answers 401.

## 4. Daily operation

* **Collections** keep using the existing screens. For engine groups, every verified payment is applied to the member's dues automatically (per `CONTRIBUTION.paymentAllocation`), staff receipts when approved; reversals undo the application.
* **Offline auction:** Auction Engine → Auctions → Open → Close → Enter result (preview first) → Save. With second-person approval configured, another manager approves under **Approvals**.
* **Online auction:** opens automatically; members bid in the app's auction room; closes at the published time (anti-sniping may extend it); the manager settles with the best bid.
* **Penalties:** Auction Engine → Groups → Dues → *Apply penalties for today* (one charge per missed instalment, never on penalties).
* **Corrections:** waivers (`/engine/adjustments`, optional second approver); a wrong auction result is reversed (`POST /engine/settlements/:id/reverse`) while its payout is still pending, then re-entered (revision 2).
* **Reports:** `/engine/reports/auctions`, `/engine/reports/arrears`, `/engine/reports/pending-decisions`, `/engine/accounting/statements`, `/engine/accounting/trial-balance`.

## 5. Things that are recorded but deliberately not decided

See `OPEN_DECISIONS.md` §2d. In short: dividends for vacant seats / rounding remainders / final auctions (kept aside, visible in the pending-decisions report), the accounting treatment of a waived contribution (recorded, not posted), cash payout of dividends (recorded as payable, no payout flow), and everything under the legal gate.
