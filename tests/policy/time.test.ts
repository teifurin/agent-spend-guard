import { describe, expect, it } from 'vitest';
import {
  formatLocalTime,
  isValidTimeZone,
  isWithinWindow,
  localMinutes,
  monthBounds,
  monthKey,
  parseHHMM,
  zonedParts,
} from '../../src/policy/time.js';

const TOKYO = 'Asia/Tokyo';
const NEW_YORK = 'America/New_York';

describe('zonedParts and monthKey', () => {
  it('reads the wall clock of a zone', () => {
    // 2026-10-31T15:30Z is already 1 November 00:30 in Tokyo
    const ms = Date.UTC(2026, 9, 31, 15, 30);
    expect(zonedParts(ms, TOKYO)).toEqual({ year: 2026, month: 11, day: 1, hour: 0, minute: 30 });
    expect(zonedParts(ms, 'UTC')).toEqual({ year: 2026, month: 10, day: 31, hour: 15, minute: 30 });
    expect(monthKey(ms, TOKYO)).toBe('2026-11');
    expect(monthKey(ms, 'UTC')).toBe('2026-10');
  });

  it('uses 00 rather than 24 at midnight', () => {
    expect(zonedParts(Date.UTC(2026, 9, 26, 15, 0), TOKYO).hour).toBe(0);
    expect(formatLocalTime(Date.UTC(2026, 9, 26, 15, 0), TOKYO)).toBe('00:00');
  });

  it('throws for an unknown zone and reports validity', () => {
    expect(() => zonedParts(0, 'Mars/Olympus')).toThrow(RangeError);
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('monthBounds', () => {
  it('covers the Tokyo calendar month in UTC instants', () => {
    const now = Date.UTC(2026, 9, 27, 3, 0); // 12:00 JST on 27 October
    expect(monthBounds(now, TOKYO)).toEqual({
      key: '2026-10',
      startMs: Date.UTC(2026, 8, 30, 15, 0), // 1 Oct 00:00 JST
      endMs: Date.UTC(2026, 9, 31, 15, 0), // 1 Nov 00:00 JST
    });
  });

  it('wraps from December into the next year', () => {
    const bounds = monthBounds(Date.UTC(2026, 11, 15), TOKYO);
    expect(bounds.key).toBe('2026-12');
    expect(bounds.endMs).toBe(Date.UTC(2026, 11, 31, 15, 0));
  });

  it('handles a half-hour zone', () => {
    const bounds = monthBounds(Date.UTC(2026, 9, 27), 'Asia/Kolkata');
    expect(bounds.startMs).toBe(Date.UTC(2026, 8, 30, 18, 30));
  });

  it('handles a DST change inside the month (New York, March 2026)', () => {
    const bounds = monthBounds(Date.UTC(2026, 2, 15, 12, 0), NEW_YORK);
    expect(bounds.key).toBe('2026-03');
    expect(bounds.startMs).toBe(Date.UTC(2026, 2, 1, 5, 0)); // EST, UTC-5
    expect(bounds.endMs).toBe(Date.UTC(2026, 3, 1, 4, 0)); // EDT, UTC-4
  });

  it('handles the DST end (New York, November 2026)', () => {
    const bounds = monthBounds(Date.UTC(2026, 10, 15, 12, 0), NEW_YORK);
    expect(bounds.startMs).toBe(Date.UTC(2026, 10, 1, 4, 0)); // still EDT at local midnight on 1 Nov
    expect(bounds.endMs).toBe(Date.UTC(2026, 11, 1, 5, 0)); // EST
  });
});

describe('local time helpers', () => {
  it('computes minutes since local midnight', () => {
    expect(localMinutes(Date.UTC(2026, 9, 27, 3, 0), TOKYO)).toBe(12 * 60);
    expect(localMinutes(Date.UTC(2026, 9, 26, 23, 59), TOKYO)).toBe(8 * 60 + 59);
    expect(formatLocalTime(Date.UTC(2026, 9, 26, 23, 59), TOKYO)).toBe('08:59');
  });

  it('parses HH:MM strictly', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('08:30')).toBe(510);
    expect(parseHHMM('23:59')).toBe(1439);
    for (const bad of ['24:00', '8:00', '08:60', '0800', '', '08:00:00']) expect(parseHHMM(bad)).toBeUndefined();
  });

  it('treats the window as [start, end) and wraps past midnight', () => {
    const start = parseHHMM('08:00')!;
    const end = parseHHMM('22:00')!;
    expect(isWithinWindow(start, start, end)).toBe(true); // exactly at start
    expect(isWithinWindow(end, start, end)).toBe(false); // exactly at end
    expect(isWithinWindow(end - 1, start, end)).toBe(true);
    expect(isWithinWindow(start - 1, start, end)).toBe(false);

    const night = parseHHMM('22:00')!;
    const morning = parseHHMM('06:00')!;
    expect(isWithinWindow(parseHHMM('23:00')!, night, morning)).toBe(true);
    expect(isWithinWindow(parseHHMM('03:00')!, night, morning)).toBe(true);
    expect(isWithinWindow(parseHHMM('06:00')!, night, morning)).toBe(false);
    expect(isWithinWindow(parseHHMM('12:00')!, night, morning)).toBe(false);
    expect(isWithinWindow(parseHHMM('12:00')!, 540, 540)).toBe(true); // start === end: whole day
  });
});
