import { FinanceInputError } from '../decimal.js';

/**
 * Auction occurrence calendar (pure; DATABASE_DESIGN §4). Dates are business dates 'YYYY-MM-DD'
 * (IST calendar), computed with UTC arithmetic so there is no time-zone drift.
 *
 *  DAILY               every `interval` days from startDate
 *  WEEKLY              every `interval` weeks (weeks start Monday) on byWeekdays (1 = Mon … 7 = Sun)
 *  MONTHLY_BY_DAY      every `interval` months on byMonthDays (1…31; -1 = last day). A day beyond the
 *                      month's length means that month's last day (e.g. 31 → 30 Apr, 28/29 Feb).
 *  MONTHLY_BY_WEEKDAY  every `interval` months on the byWeekdayOrdinal-th (1…5, -1 = last) byWeekdays[0];
 *                      a month without a 5th such weekday has no occurrence.
 *  EXPLICIT_DATES      the given dates.
 * Holidays / weekly off days per holidayPolicy: IGNORE | SKIP | NEXT_BUSINESS_DAY | PREVIOUS_BUSINESS_DAY.
 * The occurrence KEY is always the originally planned date (stable identity, survives moves).
 * maxOccurrences counts occurrences actually produced (skipped ones do not count).
 */
export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY_BY_DAY' | 'MONTHLY_BY_WEEKDAY' | 'EXPLICIT_DATES';
export type HolidayPolicy = 'IGNORE' | 'SKIP' | 'NEXT_BUSINESS_DAY' | 'PREVIOUS_BUSINESS_DAY';

export interface RecurrenceRule {
  frequency: Frequency;
  interval: number;
  byWeekdays: number[];
  byMonthDays: number[];
  byWeekdayOrdinal: number | null;
  explicitDates: string[];
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  holidayPolicy: HolidayPolicy;
  weeklyOffDays: number[];
}

export interface Occurrence {
  key: string;
  date: string;
  moved: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => {
  const x = toUtc(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fmt(x);
};
export const isoWeekday = (d: string) => {
  const w = toUtc(d).getUTCDay();
  return w === 0 ? 7 : w;
};
const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const ymd = (y: number, m0: number, day: number) => fmt(new Date(Date.UTC(y, m0, day)));

export function validateRule(r: RecurrenceRule): RecurrenceRule {
  const bad = (f: string, msg: string) => {
    throw new FinanceInputError(f, msg);
  };
  if (!['DAILY', 'WEEKLY', 'MONTHLY_BY_DAY', 'MONTHLY_BY_WEEKDAY', 'EXPLICIT_DATES'].includes(r.frequency)) bad('frequency', 'is invalid');
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 366) bad('interval', 'must be a whole number from 1 to 366');
  if (!DATE.test(r.startDate) || Number.isNaN(Date.parse(r.startDate))) bad('startDate', 'must be YYYY-MM-DD');
  if (r.endDate !== null && (!DATE.test(r.endDate) || r.endDate < r.startDate)) bad('endDate', 'must be YYYY-MM-DD on or after startDate');
  if (r.maxOccurrences !== null && (!Number.isInteger(r.maxOccurrences) || r.maxOccurrences < 1 || r.maxOccurrences > 1000)) bad('maxOccurrences', 'must be 1…1000');
  if (r.frequency !== 'EXPLICIT_DATES' && r.endDate === null && r.maxOccurrences === null) bad('endDate', 'an end date or a maximum number of auctions is required');
  if (!['IGNORE', 'SKIP', 'NEXT_BUSINESS_DAY', 'PREVIOUS_BUSINESS_DAY'].includes(r.holidayPolicy)) bad('holidayPolicy', 'is invalid');
  const weekdays = (xs: number[], f: string) => {
    if (!Array.isArray(xs) || xs.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) bad(f, 'must be weekdays 1 (Mon) … 7 (Sun)');
  };
  weekdays(r.weeklyOffDays, 'weeklyOffDays');
  if (r.weeklyOffDays.length >= 7) bad('weeklyOffDays', 'at least one working day is required');
  if (r.frequency === 'WEEKLY') {
    weekdays(r.byWeekdays, 'byWeekdays');
    if (!r.byWeekdays.length) bad('byWeekdays', 'at least one weekday is required');
  }
  if (r.frequency === 'MONTHLY_BY_DAY') {
    if (!r.byMonthDays.length || r.byMonthDays.some((x) => !Number.isInteger(x) || x === 0 || x < -1 || x > 31)) bad('byMonthDays', 'must be days 1…31 or -1 (last day)');
  }
  if (r.frequency === 'MONTHLY_BY_WEEKDAY') {
    weekdays(r.byWeekdays, 'byWeekdays');
    if (r.byWeekdays.length !== 1) bad('byWeekdays', 'exactly one weekday is required');
    if (r.byWeekdayOrdinal === null || ![1, 2, 3, 4, 5, -1].includes(r.byWeekdayOrdinal)) bad('byWeekdayOrdinal', 'must be 1…5 or -1 (last)');
  }
  if (r.frequency === 'EXPLICIT_DATES') {
    if (!r.explicitDates.length || r.explicitDates.length > 1000 || r.explicitDates.some((d) => !DATE.test(d) || Number.isNaN(Date.parse(d)))) bad('explicitDates', 'must be 1…1000 dates YYYY-MM-DD');
  }
  return r;
}

/** Planned dates (before holiday handling), ascending, from startDate up to `until`. */
function planned(r: RecurrenceRule, until: string): string[] {
  const last = r.endDate && r.endDate < until ? r.endDate : until;
  const out: string[] = [];
  const cap = 20000;
  if (r.frequency === 'EXPLICIT_DATES') return [...new Set(r.explicitDates)].filter((d) => d >= r.startDate && d <= last).sort();
  if (r.frequency === 'DAILY') {
    for (let d = r.startDate, i = 0; d <= last && i < cap; d = addDays(d, r.interval), i++) out.push(d);
    return out;
  }
  if (r.frequency === 'WEEKLY') {
    const weekStart = addDays(r.startDate, 1 - isoWeekday(r.startDate));
    const days = [...new Set(r.byWeekdays)].sort((a, b) => a - b);
    for (let w = weekStart, i = 0; w <= last && i < cap; w = addDays(w, 7 * r.interval), i++) {
      for (const wd of days) {
        const d = addDays(w, wd - 1);
        if (d >= r.startDate && d <= last) out.push(d);
      }
    }
    return out;
  }
  const s = toUtc(r.startDate);
  for (let k = 0, i = 0; i < cap; k += r.interval, i++) {
    const y = s.getUTCFullYear() + Math.floor((s.getUTCMonth() + k) / 12);
    const m0 = (s.getUTCMonth() + k) % 12;
    if (ymd(y, m0, 1) > last) break;
    const n = daysInMonth(y, m0);
    let days: number[] = [];
    if (r.frequency === 'MONTHLY_BY_DAY') days = [...new Set(r.byMonthDays.map((d) => (d === -1 ? n : Math.min(d, n))))].sort((a, b) => a - b);
    else {
      const wd = r.byWeekdays[0];
      const firstWd = isoWeekday(ymd(y, m0, 1));
      const first = 1 + ((wd - firstWd + 7) % 7);
      const matches = [];
      for (let d = first; d <= n; d += 7) matches.push(d);
      const pick = r.byWeekdayOrdinal === -1 ? matches[matches.length - 1] : matches[(r.byWeekdayOrdinal as number) - 1];
      if (pick) days = [pick];
    }
    for (const d of days) {
      const date = ymd(y, m0, d);
      if (date >= r.startDate && date <= last) out.push(date);
    }
  }
  return out;
}

/**
 * Occurrences from startDate up to `until` (inclusive), after holiday handling and maxOccurrences.
 * Deterministic: the same rule and holidays always produce the same list.
 */
export function occurrences(rule: RecurrenceRule, until: string, holidays: Iterable<string> = []): Occurrence[] {
  const r = validateRule(rule);
  const hol = new Set(holidays);
  const isBusiness = (d: string) => !hol.has(d) && !r.weeklyOffDays.includes(isoWeekday(d));
  const out: Occurrence[] = [];
  const taken = new Set<string>();
  // plan beyond `until` a little so PREVIOUS_BUSINESS_DAY moves into range are seen
  for (const key of planned(r, r.holidayPolicy === 'PREVIOUS_BUSINESS_DAY' ? addDays(until, 31) : until)) {
    let date = key;
    if (!isBusiness(key)) {
      if (r.holidayPolicy === 'SKIP') continue;
      if (r.holidayPolicy === 'NEXT_BUSINESS_DAY' || r.holidayPolicy === 'PREVIOUS_BUSINESS_DAY') {
        const step = r.holidayPolicy === 'NEXT_BUSINESS_DAY' ? 1 : -1;
        let guard = 0;
        while (!isBusiness(date) && guard++ < 60) date = addDays(date, step);
        if (!isBusiness(date)) continue;
      }
    }
    if (date > until || date < r.startDate || (r.endDate && date > r.endDate && r.holidayPolicy !== 'NEXT_BUSINESS_DAY')) continue;
    if (taken.has(date)) continue; // a moved occurrence collides with another one: keep the first
    taken.add(date);
    out.push({ key, date, moved: date !== key });
    if (r.maxOccurrences !== null && out.length >= r.maxOccurrences) break;
  }
  return out;
}

/** "HH:mm" on an IST business date → UTC instant (IST = UTC+05:30, no daylight saving). */
export function istInstant(date: string, hhmm: string): Date {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new FinanceInputError('time', 'must be HH:mm');
  const [h, mi] = hhmm.split(':').map(Number);
  if (h > 23 || mi > 59) throw new FinanceInputError('time', 'must be HH:mm');
  return new Date(Date.parse(`${date}T${hhmm}:00+05:30`));
}
