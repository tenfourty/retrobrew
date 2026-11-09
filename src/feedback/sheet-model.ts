// What the feedback sheet decides from what the person has typed, as plain functions so they can be tested without a page.
import { COPY, TROUBLE_LINES } from './copy';
import { LIMITS, looksLikeMeetingLink, normaliseEmail, normaliseMessage, type FeedbackKind, type TroubleSource } from './schema';
import type { SendFailure } from './send';
import type { Trouble } from './trouble';

export interface MessageState {
  empty: boolean;
  /** Characters left of the 2,000, counting what is typed. */
  left: number;
  /** The text carries a meeting link: Send stays off until it is taken out. */
  link: boolean;
}

export function messageState(text: string): MessageState {
  const whole = normaliseMessage(text, Infinity);
  return { empty: whole === '', left: LIMITS.message - text.length, link: looksLikeMeetingLink(whole) };
}

/** The count shown under the box: nothing until 200 are left. */
export function countText(left: number): string | null {
  return left <= 200 ? `${Math.max(left, 0)} left` : null;
}

/** What the polite count line speaks: only at 100, 50, 20 and 0 left, not on every key. */
export function countAnnouncement(left: number): string {
  return left === 100 || left === 50 || left === 20 || left === 0 ? `${left} left` : '';
}

/** True when pasting `pasted` over the selection takes the text past the limit, so the browser will cut it. */
export function pasteOverflows(current: string, selectionStart: number, selectionEnd: number, pasted: string): boolean {
  return current.length - (selectionEnd - selectionStart) + pasted.length > LIMITS.message;
}

export type EmailState = 'empty' | 'ok' | 'invalid';

export function emailState(text: string): EmailState {
  if (text.trim() === '') return 'empty';
  return normaliseEmail(text) ? 'ok' : 'invalid';
}

export function canSend(state: { empty: boolean; link: boolean; email: EmailState; sending: boolean; online: boolean }): boolean {
  return !state.empty && !state.link && state.email !== 'invalid' && !state.sending && state.online;
}

export function failureLine(reason: SendFailure): string {
  if (reason === 'rate') return COPY.failedRate;
  if (reason === 'rejected') return COPY.failedRejected;
  return COPY.failed;
}

export function initialKind(trouble: Trouble | null): FeedbackKind {
  return trouble ? 'broke' : 'other';
}

export function troubleLine(source: TroubleSource): string {
  return TROUBLE_LINES[source];
}

/** What the person has written so far. Kept in memory for the page's life, so Cancel and reopening shows it again. */
export interface Draft { kind: FeedbackKind | null; message: string; email: string }
let draft: Draft = { kind: null, message: '', email: '' };
export const getDraft = (): Draft => draft;
export const setDraft = (next: Draft): void => { draft = next; };
export const clearDraft = (): void => { draft = { kind: null, message: '', email: '' }; };
