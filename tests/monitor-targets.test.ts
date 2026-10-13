import { describe, expect, it } from 'vitest';
import { BOARDING_SLOTS, boardingDateAllowed, boardingDateRange, boardingSlotAllowed } from '../src/monitor-targets.js';

describe('monitor boarding target choices', () => {
  it.each([
    ['2026-10-12T23:59:59+09:00', '2026-10-12', '2026-10-26'],
    ['2026-10-13T00:00:00+09:00', '2026-10-13', '2026-10-26'],
    ['2026-10-13T08:59:59.999+09:00', '2026-10-13', '2026-10-26'],
    ['2026-10-13T09:00:00+09:00', '2026-10-13', '2026-10-27'],
    ['2026-12-31T09:00:00+09:00', '2026-12-31', '2027-01-14'],
    ['2028-02-16T09:00:00+09:00', '2028-02-16', '2028-03-01'],
  ])('uses Japan calendar dates and the 09:00 opening boundary at %s', (now, min, max) => {
    expect(boardingDateRange(Date.parse(now))).toEqual({ min, max });
  });

  it.each(['2026-10-13T09:00:00+09:00', '2026-10-13T00:00:00Z', '2026-10-12T17:00:00-07:00'])(
    'returns the same Japan range for the same instant represented as %s', (now) => {
    expect(boardingDateRange(Date.parse(now))).toEqual({ min: '2026-10-13', max: '2026-10-27' });
    });

  it('accepts both date endpoints and rejects outside or impossible dates', () => {
    const range = boardingDateRange(Date.parse('2028-02-20T09:00:00+09:00'));
    for (const date of [range.min, '2028-02-29', range.max]) expect(boardingDateAllowed(date, range)).toBe(true);
    for (const date of ['2028-02-19', '2028-03-06', '2028-02-30', '2028-2-29']) expect(boardingDateAllowed(date, range)).toBe(false);
  });

  it('offers exactly the 17 half-hour start times from 08:00 through 16:00', () => {
    expect(BOARDING_SLOTS).toEqual([
      '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00',
      '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00',
    ]);
    for (const slot of BOARDING_SLOTS) expect(boardingSlotAllowed(slot)).toBe(true);
    for (const slot of ['07:30', '08:01', '08:15', '16:01', '16:30', '8:00', '08:00:00']) expect(boardingSlotAllowed(slot)).toBe(false);
  });
});
