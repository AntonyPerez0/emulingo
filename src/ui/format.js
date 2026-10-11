// Human-friendly formatting for counts, durations, sizes and times.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const nf = new Intl.NumberFormat('en');
const nf1 = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

function oneDecimal(n) {
  return nf1.format(Math.round(n * 10) / 10);
}

/**
 * Compact SRS interval for button labels: '<1 min', '10 min', '3 h', '1 day',
 * '4 days', '2 mo', '1.5 yr'.
 */
export function formatInterval(ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (v < MINUTE) return '<1 min';
  // Each unit hands over to the next once it would round up to it (59.6 min → '1 h', not '60 min').
  const min = Math.round(v / MINUTE);
  if (min < 60) return `${min} min`;
  const h = Math.round(v / HOUR);
  if (h < 24) return `${h} h`;
  const d = Math.round(v / DAY);
  if (d < 30) return `${d} ${d === 1 ? 'day' : 'days'}`;
  const mo = Math.round(v / MONTH);
  if (mo < 12 && v < YEAR) return `${mo} mo`;
  return `${oneDecimal(Math.max(1, v / YEAR))} yr`;
}

/**
 * formatCount(3, 'card') → '3 cards'; formatCount(1, ['entry', 'entries']) → '1 entry'.
 * Numbers get thousands separators.
 */
export function formatCount(n, noun) {
  const value = Number(n) || 0;
  const [one, many] = Array.isArray(noun) ? noun : [noun, `${noun}s`];
  return `${nf.format(value)} ${Math.abs(value) === 1 ? one : many}`;
}

/** 0 → '0 B', 1536 → '1.5 KB', 13_000_000 → '12.4 MB'. */
export function formatBytes(n) {
  let v = Math.max(0, Number(n) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  // Step up while the value would display as 1024 or more (1023.7 KB → '1 MB').
  while (Math.round(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  if (i === 0) return `${Math.round(v)} B`;
  return `${v >= 10 ? Math.round(v) : oneDecimal(v)} ${units[i]}`;
}

const rtf = typeof Intl.RelativeTimeFormat === 'function' ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null;

/**
 * Relative time from now: 'just now', '5 minutes ago', 'yesterday', 'in 3 hours',
 * falling back to a short date beyond a month.
 */
export function formatRelative(ts, now = Date.now()) {
  const t = ts instanceof Date ? ts.getTime() : Number(ts);
  if (!Number.isFinite(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return 'just now';
  if (!rtf) return new Date(t).toLocaleString();
  const sign = Math.sign(diff);
  // As in formatInterval, a unit hands over once it would round up to the next one.
  const min = Math.max(1, Math.round(abs / MINUTE));
  if (min < 60) return rtf.format(sign * min, 'minute');
  const h = Math.round(abs / HOUR);
  if (h < 24) return rtf.format(sign * h, 'hour');
  const days = Math.round(abs / DAY);
  if (days < 7) return rtf.format(sign * days, 'day');
  if (abs < MONTH) return rtf.format(sign * Math.round(abs / (7 * DAY)), 'week');
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
