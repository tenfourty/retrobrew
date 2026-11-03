// How times, timeboxes and dates are written everywhere (docs/product/mvp-screens.md, Lengths).
// Rehearsal boards write a timebox by its real length, so every function here takes milliseconds or a minute length.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function split(ms: number): { m: number; s: number } {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  return { m: Math.floor(total / 60), s: total % 60 };
}

// In labels: "1 min", "30 min", "10 s", "50 s", "1 min 40 s".
export function lengthLabel(ms: number): string {
  const { m, s } = split(ms);
  if (m === 0) return `${s} s`;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

// A timebox or extension of `minutes` on a timer whose minute lasts `minuteMs`, as a label.
export function timeboxLabel(minutes: number, minuteMs: number): string {
  return lengthLabel(minutes * minuteMs);
}

// In sentences: "1 minute", "3 minutes", "10 seconds".
export function lengthSentence(ms: number): string {
  const { m, s } = split(ms);
  if (m === 0) return `${s} ${plural(s, 'second', 'seconds')}`;
  if (s === 0) return `${m} ${plural(m, 'minute', 'minutes')}`;
  return `${m} ${plural(m, 'minute', 'minutes')} and ${s} ${plural(s, 'second', 'seconds')}`;
}

// Added time, in sentences: "1 more minute", "3 more minutes", "30 more seconds".
// A rehearsal timebox of 10 minutes or more runs for minutes and seconds: "1 minute and 40 more seconds".
export function moreSentence(ms: number): string {
  const { m, s } = split(ms);
  if (m === 0) return `${s} more ${plural(s, 'second', 'seconds')}`;
  if (s === 0) return `${m} more ${plural(m, 'minute', 'minutes')}`;
  return `${m} ${plural(m, 'minute', 'minutes')} and ${s} more ${plural(s, 'second', 'seconds')}`;
}

// "6 Oct 2026", in local time. Built by hand so every browser writes it the same way.
// An invalid time gives "".
export function shortDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

// "6 October 2026", in local time, for Copy as text.
export function longDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}
