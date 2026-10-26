/**
 * The one date and time format for every screen: "10 Oct 2026" for a date,
 * "13:51" for a time (24-hour), "10 Oct 2026, 13:51" for both, always in the
 * viewer's own time zone. Month names are fixed English, like the rest of
 * the interface, so a date reads the same on every screen.
 *
 * Timestamps from the database are UTC without a zone ("2026-10-10
 * 10:51:34", SQLite datetime('now')); ISO strings with "Z" or an offset are
 * read as written. A bare date ("2026-10-10", e.g. a source's publish date)
 * is a calendar day, not a moment, so it is never shifted by a time zone.
 *
 * Client components render through components/LocalDate.tsx, which shows the
 * UTC reading on the server and switches to local time once in the browser.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

export interface FormatOptions {
  /** Read in UTC instead of the local zone (server render). */
  utc?: boolean;
}

/** A Date for a stored timestamp, or null when it can't be read. */
export function parseTimestamp(value: string): Date | null {
  const s = value.trim();
  if (s === '') return null;
  const iso = DATE_ONLY.test(s)
    ? `${s}T00:00:00Z`
    : s.replace(' ', 'T') + (HAS_ZONE.test(s) ? '' : 'Z');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, '0');

interface Parts {
  day: number;
  month: number;
  year: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function parts(value: string, options: FormatOptions): Parts | null {
  const d = parseTimestamp(value);
  if (!d) return null;
  // A bare date is a calendar day: read it as written.
  const utc = options.utc === true || DATE_ONLY.test(value.trim());
  return utc
    ? {
        day: d.getUTCDate(),
        month: d.getUTCMonth(),
        year: d.getUTCFullYear(),
        hours: d.getUTCHours(),
        minutes: d.getUTCMinutes(),
        seconds: d.getUTCSeconds(),
      }
    : {
        day: d.getDate(),
        month: d.getMonth(),
        year: d.getFullYear(),
        hours: d.getHours(),
        minutes: d.getMinutes(),
        seconds: d.getSeconds(),
      };
}

/** "10 Oct 2026". Unreadable input comes back unchanged. */
export function formatDate(value: string, options: FormatOptions = {}): string {
  const p = parts(value, options);
  return p ? `${p.day} ${MONTHS[p.month]} ${p.year}` : value;
}

/** "13:51", or "13:51:20" with `seconds` (step logs). Unreadable input comes back unchanged. */
export function formatTime(value: string, options: FormatOptions & { seconds?: boolean } = {}): string {
  const p = parts(value, options);
  if (!p) return value;
  const hm = `${pad(p.hours)}:${pad(p.minutes)}`;
  return options.seconds ? `${hm}:${pad(p.seconds)}` : hm;
}

/** "10 Oct 2026, 13:51". Unreadable input comes back unchanged. */
export function formatDateTime(value: string, options: FormatOptions = {}): string {
  const p = parts(value, options);
  if (!p) return value;
  return `${p.day} ${MONTHS[p.month]} ${p.year}, ${pad(p.hours)}:${pad(p.minutes)}`;
}
