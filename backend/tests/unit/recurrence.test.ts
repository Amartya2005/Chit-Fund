import { describe, expect, it } from 'vitest';
import { occurrences, istInstant, RecurrenceRule, validateRule } from '../../src/finance/schedule/recurrence.js';

const rule = (over: Partial<RecurrenceRule>): RecurrenceRule => ({
  frequency: 'DAILY', interval: 1, byWeekdays: [], byMonthDays: [], byWeekdayOrdinal: null, explicitDates: [],
  startDate: '2027-01-01', endDate: '2027-12-31', maxOccurrences: null, holidayPolicy: 'IGNORE', weeklyOffDays: [], ...over,
});
const dates = (r: RecurrenceRule, until = '2027-12-31', hol: string[] = []) => occurrences(r, until, hol).map((o) => o.date);

describe('recurrence', () => {
  it('daily, every n days, end date and max occurrences', () => {
    expect(dates(rule({ interval: 3, endDate: '2027-01-10' }))).toEqual(['2027-01-01', '2027-01-04', '2027-01-07', '2027-01-10']);
    expect(dates(rule({ endDate: null, maxOccurrences: 3 }))).toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
  });
  it('weekly on selected weekdays, every 2 weeks (2027-01-01 is a Friday)', () => {
    expect(dates(rule({ frequency: 'WEEKLY', byWeekdays: [1, 5], interval: 2, endDate: '2027-01-31' }))).toEqual(['2027-01-01', '2027-01-11', '2027-01-15', '2027-01-25', '2027-01-29']);
  });
  it('monthly by day: 31 means the last day of shorter months; -1 is the last day; leap year', () => {
    expect(dates(rule({ frequency: 'MONTHLY_BY_DAY', byMonthDays: [31], endDate: '2027-04-30' }))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(dates(rule({ frequency: 'MONTHLY_BY_DAY', byMonthDays: [-1], startDate: '2028-01-15', endDate: '2028-03-31' }), '2028-12-31')).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    expect(dates(rule({ frequency: 'MONTHLY_BY_DAY', byMonthDays: [5], interval: 3, endDate: '2027-12-31' }))).toEqual(['2027-01-05', '2027-04-05', '2027-07-05', '2027-10-05']);
  });
  it('monthly by weekday: second Saturday, last Monday; months without a 5th weekday are skipped', () => {
    expect(dates(rule({ frequency: 'MONTHLY_BY_WEEKDAY', byWeekdays: [6], byWeekdayOrdinal: 2, endDate: '2027-03-31' }))).toEqual(['2027-01-09', '2027-02-13', '2027-03-13']);
    expect(dates(rule({ frequency: 'MONTHLY_BY_WEEKDAY', byWeekdays: [1], byWeekdayOrdinal: -1, endDate: '2027-02-28' }))).toEqual(['2027-01-25', '2027-02-22']);
    expect(dates(rule({ frequency: 'MONTHLY_BY_WEEKDAY', byWeekdays: [5], byWeekdayOrdinal: 5, endDate: '2027-04-30' }))).toEqual(['2027-01-29', '2027-04-30']);
  });
  it('holidays and weekly off days: skip, next, previous; keys stay the planned dates; collisions keep the first', () => {
    const r = (p: RecurrenceRule['holidayPolicy']) => rule({ endDate: '2027-01-05', holidayPolicy: p, weeklyOffDays: [7] }); // 2027-01-03 is a Sunday
    expect(dates(r('IGNORE'), '2027-12-31', ['2027-01-02'])).toEqual(['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']);
    expect(dates(r('SKIP'), '2027-12-31', ['2027-01-02'])).toEqual(['2027-01-01', '2027-01-04', '2027-01-05']);
    const next = occurrences(r('NEXT_BUSINESS_DAY'), '2027-12-31', ['2027-01-02']);
    // 01-02 → 01-04 and 01-03 → 01-04 collide: the first keeps 01-04, the second is dropped; 01-04's own planned date then collides too
    expect(next.map((o) => [o.key, o.date])).toEqual([['2027-01-01', '2027-01-01'], ['2027-01-02', '2027-01-04'], ['2027-01-05', '2027-01-05']]);
    const monthly = rule({ frequency: 'MONTHLY_BY_DAY', byMonthDays: [26], endDate: '2027-03-31', holidayPolicy: 'PREVIOUS_BUSINESS_DAY' });
    expect(occurrences(monthly, '2027-12-31', ['2027-01-26']).map((o) => [o.key, o.date, o.moved])).toEqual([
      ['2027-01-26', '2027-01-25', true], ['2027-02-26', '2027-02-26', false], ['2027-03-26', '2027-03-26', false],
    ]);
  });
  it('explicit dates; validation refuses open-ended or malformed rules', () => {
    expect(dates(rule({ frequency: 'EXPLICIT_DATES', explicitDates: ['2027-05-01', '2027-02-01', '2027-02-01'], endDate: null }))).toEqual(['2027-02-01', '2027-05-01']);
    expect(() => validateRule(rule({ endDate: null }))).toThrow(/end date/);
    expect(() => validateRule(rule({ frequency: 'WEEKLY', byWeekdays: [] }))).toThrow(/weekday/);
    expect(() => validateRule(rule({ frequency: 'MONTHLY_BY_DAY', byMonthDays: [0] }))).toThrow(/byMonthDays/);
    expect(() => validateRule(rule({ weeklyOffDays: [1, 2, 3, 4, 5, 6, 7] }))).toThrow(/working day/);
  });
  it('deterministic and IST times convert exactly (UTC+05:30)', () => {
    const r = rule({ frequency: 'WEEKLY', byWeekdays: [3], endDate: '2027-06-30' });
    expect(dates(r)).toEqual(dates(r));
    expect(istInstant('2027-01-06', '18:00').toISOString()).toBe('2027-01-06T12:30:00.000Z');
    expect(istInstant('2027-01-06', '03:00').toISOString()).toBe('2027-01-05T21:30:00.000Z');
  });
});
