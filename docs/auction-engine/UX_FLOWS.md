# ChitKart 2.0 — UX Flows and Screen Structure

Status: **DRAFT — no frontend work in this phase.** Labels: [EXISTING] · [PROPOSED] · [DECISION D-xx].

---

## 1. Current UI baseline [EXISTING]

* Single Expo app (React Native + web export), role-based top navigation in `mobile/App.tsx`; manager modules in `mobile/src/modules/manager/*Tab.tsx`.
* Manager auction screen `AuctionsPayoutsTab.tsx`: two sub-tabs (*Conduct Auction & Dividend*, *Prize Payouts*); fields: group chip, instalment number, auction date, winning discount, winner list; a live breakdown computed in the browser with floats.
* Known issues to fix before/with the new flows: E1 (wrong field name → auction confirmation fails), E2 (prized flags never returned), E10 (INR grouping not `en-IN`).
* Visual language: dark navy header, lime accent, cards with coloured left borders, emoji tab icons; verified responsive at 390 px and 1366 px without horizontal overflow.

New screens reuse this visual language and component style (`commonStyles.ts`) rather than introducing a new design system.

---

## 2. UX principles applied
1. **One decision per step.** Wizards with 4–6 short steps; advanced options collapsed behind "More options".
2. **Plain language first, finance term second:** "Amount the winner gives up (*discount*)", "Foreman's fee (*commission*)", "Shared back to everyone (*dividend*)".
3. **Always show the money.** Every configuration step shows a live worked example using the group's own numbers (from the backend preview endpoint, never computed client-side).
4. **Visual breakdown:** a stacked bar of the chit value split into *winner receives / foreman fee / shared to members*; per-member dividend shown as "₹1,000 off next month".
5. **Irreversible actions** (settle, cancel, reverse, activate config) require a confirmation sheet summarising consequences, and a typed confirmation for settlement above a threshold.
6. **INR formatting** `₹1,00,000.00` via `Intl.NumberFormat('en-IN')`; dates `dd MMM yyyy`, times in IST with the zone shown in the auction room.
7. **Empty states** explain what to do next ("No auctions scheduled — set a schedule for this group").
8. **Validation messages** say what is allowed ("Maximum discount for this group is ₹30,000 (30 % of the chit value)").
9. **Accessibility:** touch targets ≥ 44 px, colour never the only signal (icons + text for eligible/ineligible), screen-reader labels on countdown and bid buttons, reduced-motion respected.
10. **Mobile first:** single-column layouts; sticky primary action at the bottom on phones.

---

## 3. Information architecture

```
Manager
├── Dashboard (existing) + "Today's auctions" card [PROPOSED]
├── Auctions [PROPOSED replaces "Auctions & Payouts"]
│   ├── Calendar (day / week / month, filter by group)
│   ├── Auction detail / Auction room (offline entry or live monitor)
│   ├── Approvals inbox
│   ├── History (settled, cancelled, reversed)
│   └── Payouts (existing sub-tab, kept)
├── Chit Groups (existing) → Group detail → "Financial settings" tab [PROPOSED]
│   ├── Summary (plain-language card)
│   ├── Contributions & dues
│   ├── Auction rules
│   ├── Schedule
│   ├── Eligibility & defaults
│   └── Change history
├── Company settings [PROPOSED] → Financial defaults, Holidays, Account mapping, Interest products (if enabled)
├── Interest accounts [PROPOSED, only if Model B enabled]
└── Reports (existing Accounting) + Auction & dividend reports

Member [PROPOSED, requires D-02]
├── Home: next due, next auction, my tickets
├── Auctions: upcoming / live / results
├── My money: contributions, dividends, outstanding, receipts, statements
└── Loans (only if Model B enabled)

Staff (existing tabs) + [PROPOSED]
├── Collections worklist (revised amounts, overdue first)
└── Auction calendar (assigned groups, read-only; attendance marking if D-17)
```

---

## 4. Manager workflows

### 4.1 Company financial defaults (one-time, progressive)
1. *Choose a starting template* — cards: "Monthly chit (auction & contribution monthly)", "Weekly auction, monthly contribution", "Daily small-ticket chit", "Start blank". Banner: "Templates are examples. Confirm limits and rules with your legal adviser."
2. *Legal limits* (read-only for managers; set by super admin after legal sign-off). If missing: blocking notice "Your administrator has not set legal limits yet; auctions cannot be activated."
3. *Commission & dividend* — rate, basis, who funds the commission (shown as a diagram), dividend sharing rule.
4. *Contributions & lateness* — due day, grace days, penalty rule (with example "Paid 10 days late → ₹X").
5. *Eligibility* — toggles with explanations (e.g. "Members with overdue dues above ₹__ cannot bid").
6. *Review* — plain-language summary + worked example → *Save as draft* / *Activate*.

**P2 status:** a read-only *Financial settings* view exists on each chit group (button "⚙️ Financial Settings", `mobile/src/modules/manager/FinancialSettingsModal.tsx`): plain-language values, a source chip per value, "Not decided" for open decisions, violations and warnings, change history (managers). The editing steps above (templates, wizard) are not built yet; settings are created through the API. Verified in the web build at desktop and phone widths.

### 4.2 Create auction configuration wizard (per group)
| Step | Content | Key UX |
|---|---|---|
| 1 Basics | chit value, number of tickets, contribution amount (auto, with rounding note) | Inline note if not divisible: "₹5,00,000 ÷ 30 = ₹16,666.67; total over the group differs by ₹0.10 — handled by rounding rule." |
| 2 How auctions run | Offline / Online / Both; open or sealed bids; min/max discount; bid step | Inherited values shown with "Company default" chip and an *Override* link |
| 3 When | Auction schedule (repeat picker like a calendar app) + contribution schedule (separate) | Preview list of next 10 dates with holidays marked; warning when auction and contribution frequencies differ (D-06) explaining the funding gap |
| 4 Who can win | eligibility rules, max wins per ticket (locked if statutory), foreman ticket rule | Each rule shows how many current members it would exclude |
| 5 Lateness & defaults | grace, penalty, deductions from prize | Example calculation |
| 6 Review & activate | summary card + stacked-bar example | Confirmation sheet: "This applies to future auctions only. Locked auctions are not affected." |

### 4.3 Auction dashboard and calendar
* Today strip: status pills `Scheduled · Open · Closed · Awaiting approval · Settled · Postponed · Cancelled`.
* Calendar: month grid on desktop, agenda list on phones; colour + icon per status; tap → auction detail.
* Actions on a scheduled auction: *Open now*, *Postpone*, *Cancel* (sheet with reason), *Edit this auction's settings* (only whitelisted fields, before lock).

### 4.4 Offline auction result entry
1. Header: group, auction #, scheduled time, mode, config snapshot "Locked 07 Nov 10:59 · Settings v3".
2. *Eligible tickets* list with search; ineligible tickets greyed with reason chips ("Already won #3", "₹9,000 overdue").
3. Enter winning discount (numeric keypad, ₹ prefix, bounds hint) → select winner → optional attendance & minutes upload.
4. **Calculation preview** card (from `POST /preview`): stacked bar + table (commission, dividend pool, per ticket, remainder destination, gross prize, deductions, net prize, next due per ticket) + "How was this calculated?" expandable step list.
5. Primary action: *Submit for approval* (or *Settle* when no approval required) → confirmation sheet listing what will happen (payout created, N dividends credited, journal entries posted, members notified).

### 4.5 Approval inbox (checker)
List with amount, group, maker, age; detail shows the same preview plus differences from the previous auction; actions *Approve & settle* / *Reject with reason*. Maker cannot approve own submission.

### 4.6 Live auction monitor (online mode, manager)
Countdown, participants joined/eligible, best bid, bid feed (sequence, ticket, amount, time), extension indicator, *Close now* (confirmation), *Cancel* (reason). After close → winner proposal → same preview/approve/settle flow.

### 4.7 Winner & payout
Existing *Prize Payouts* screen extended: payout card shows gross, deductions (with source), net, KYC/bank status, documents checklist (D-15), status timeline `Pending → Approved → Disbursed`.

### 4.8 Interest configuration and repayment schedule (only if enabled)
Product wizard: type (simple/compound) → method (flat/reducing) → rate & day count → repayment pattern → grace/penalties → prepayment → review with schedule table and effective-rate disclosure. Account screen: schedule table (paid/due/overdue rows), accrual timeline, *Record repayment* (allocation preview), *Prepayment quote*.

### 4.9 History & reports
Auction history table (filters: group, status, date), each row → immutable record (snapshot, bids, decisions, calculation, settlement, journal entries). Reports: dividends per member, commission earned, discount trend per group, arrears ageing, payouts pending.

---

## 5. Member workflows (requires D-02 MEMBER role)

| Screen | Content |
|---|---|
| Home | Next due (amount after dividend, due date), next auction (countdown, eligibility badge), tickets list |
| Upcoming auctions | Cards per auction: date/time IST, chit value, my eligibility ("You can bid" / "Not eligible: ₹9,000 overdue — pay to become eligible") |
| Auction room (live) | Big countdown (server-synced), current best discount (open mode), *Your bid* input with stepper (+₹100), bounds hint, *Place bid* → confirmation sheet ("You will receive ₹81,500 if you win") → result toast; connection indicator (Live / Reconnecting / Offline — bidding disabled while offline) |
| Bid history | Own bids with status (accepted/rejected + reason); public feed masked to ticket numbers |
| Result | Winner ticket, discount, "Your dividend: ₹1,000 off next month's contribution" |
| My money | Contributions (paid/due/overdue), dividends received, outstanding, receipts (existing receipt numbers), downloadable statement |
| Loans (if enabled) | Schedule, next EMI, interest breakdown, prepayment quote |

Copy example for the bid confirmation: "Bid ₹18,500 discount? If you win, you will receive ₹81,500 (₹1,00,000 − ₹18,500), before any deductions for unpaid dues. Bids cannot be withdrawn."

---

## 6. Staff workflows

* **Collections worklist** (extension of existing Collections tab): per assigned group, members sorted by overdue first, showing *amount due after dividend*, penalty, last payment; tap → existing collection form with amount prefilled; allocation preview before submit.
* **Auction calendar** (read-only) for assigned groups; reminder list of members to inform.
* **Attendance** at offline auctions (only if D-17 enables it): mark present/absent/proxy.
* **Proxy bids** only if D-16 allows, always labelled "entered by staff" in the bid history.

---

## 7. Presets (examples only — not legal advice)

| Preset | Auction | Contribution | Mode | Notes shown to user |
|---|---|---|---|---|
| Monthly classic | monthly, fixed day | monthly | offline | mirrors current behaviour (commission from discount, dividend next month) |
| Weekly auction / monthly contribution | weekly | monthly | offline or online | shows funding-gap warning (D-06) |
| Daily small-ticket | daily, business days | daily | online | requires online auction approval (L-05) |

Every preset leaves legal limit fields empty and requires the company's legal limit profile.

---

## 8. Screen inventory (for estimation)
Manager: 14 screens/sheets (calendar, auction detail, offline entry, preview, approval inbox, live monitor, history, group financial settings ×6 sections, company defaults wizard, holidays, account mapping). Member: 7. Staff: 2 extensions. Interest (optional): 5. Shared components: money input, INR display, stacked breakdown bar, step-by-step explanation list, countdown (server-synced), eligibility badge, confirmation sheet, status timeline.
