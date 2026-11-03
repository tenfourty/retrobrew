// A countdown as m:ss, in both modes (docs/product/mvp-screens.md, Lengths).
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

// A topic is 1 to 280 characters, counted as code points, on one line. The counter shows from 240.
export const TOPIC_MAX = 280;
export const COUNTER_FROM = 240;

export function charactersLeftText(length: number): string {
  const left = Math.max(0, TOPIC_MAX - length);
  return left === 1 ? '1 character left' : `${left} characters left`;
}

export function topicLength(text: string): number {
  return [...text].length;
}

// What the topic field keeps as someone types or pastes: line breaks become spaces, and it stops at 280.
export function capTopic(text: string): string {
  return [...text.replace(/\r\n|[\r\n\p{Zl}\p{Zp}]/gu, ' ')].slice(0, TOPIC_MAX).join('');
}

// The field's value after an edit that left the caret at `caret` (UTF-16 offset in `next`). The text before the caret
// that `previous` already had and everything after the caret stay; only what overflowed from the inserted text is cut,
// so typing or pasting into the middle of a full field never drops the existing tail. Returns the caret to restore.
export function capAtCaret(previous: string, next: string, caret: number): { text: string; caret: number } {
  const at = Math.min(Math.max(caret, 0), next.length);
  let prefix = 0;
  while (prefix < at && prefix < previous.length && previous[prefix] === next[prefix]) prefix++;
  const kept = capTopic(next.slice(0, prefix));
  const inserted = capTopic(next.slice(prefix, at));
  const tail = capTopic(next.slice(at));
  const room = TOPIC_MAX - topicLength(kept) - topicLength(tail);
  if (room < 0) return { text: capTopic(next), caret: Math.min(at, capTopic(next).length) };
  const cut = [...inserted].slice(0, room).join('');
  return { text: kept + cut + tail, caret: (kept + cut).length };
}
