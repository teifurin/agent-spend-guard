/**
 * Time-zone helpers built on Intl only (no library). Everything is minute precision.
 * The policy month and the allowed-hours window are both expressed in the policy's IANA zone.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

export interface MonthBounds {
  /** 'YYYY-MM' in the zone. */
  key: string;
  /** UTC ms of local midnight on the 1st, inclusive. */
  startMs: number;
  /** UTC ms of local midnight on the 1st of the next month, exclusive. */
  endMs: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // hourCycle 'h23' rather than hour12:false, which yields "24" at midnight on some engines
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in a zone. Throws RangeError for an unknown zone. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { year: field('year'), month: field('month'), day: field('day'), hour: field('hour'), minute: field('minute') };
}

/** Zone offset in ms (wall clock minus UTC) at the given instant. */
function offsetAt(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const utcMinute = Math.floor(ms / 60_000) * 60_000;
  return wall - utcMinute;
}

/** UTC instant of local midnight on the 1st of a month. The second pass corrects for a DST change between the guess and the answer. */
function monthStartUtc(year: number, month: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, 1);
  const firstGuess = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(firstGuess, timeZone);
}

export function monthBounds(nowMs: number, timeZone: string): MonthBounds {
  const { year, month } = zonedParts(nowMs, timeZone);
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    key: monthKeyOf(year, month),
    startMs: monthStartUtc(year, month, timeZone),
    endMs: monthStartUtc(next.year, next.month, timeZone),
  };
}

export function monthKey(nowMs: number, timeZone: string): string {
  const { year, month } = zonedParts(nowMs, timeZone);
  return monthKeyOf(year, month);
}

function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Minutes since local midnight. */
export function localMinutes(nowMs: number, timeZone: string): number {
  const p = zonedParts(nowMs, timeZone);
  return p.hour * 60 + p.minute;
}

/** Local wall-clock time as 'HH:MM'. */
export function formatLocalTime(nowMs: number, timeZone: string): string {
  const p = zonedParts(nowMs, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' (24-hour) to minutes since midnight; undefined when malformed. */
export function parseHHMM(value: string): number | undefined {
  const m = HHMM.exec(value);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/**
 * Whether a local time falls in [start, end), all in minutes since midnight.
 * A window with start > end wraps past midnight (22:00-06:00). start === end means the whole day.
 */
export function isWithinWindow(localMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true;
  return startMin < endMin ? localMin >= startMin && localMin < endMin : localMin >= startMin || localMin < endMin;
}
