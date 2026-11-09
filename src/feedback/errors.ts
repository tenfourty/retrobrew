// Error capture for the report: a small ring of the last three errors, scrubbed so board text cannot ride along.
//
// Nothing here sends anything. Capture only fills the ring (and tells the caller, so the trouble latch can start); a report
// leaves the device when the person presses Send, never before.
import { cap, int, stackFrame, type ErrorInput, type StackFrame } from './inputs';
import { cleanLine, ERROR_NAMES, looksLikeMeetingLink, LIMITS, type ErrorName, type ErrorSource } from './schema';

// ---- The canary -----------------------------------------------------------------------------------------

// Strings the app holds that must never appear in a report: the meeting's name, topics, people's names, its key, the page's
// whole address fragment. Write-only: nothing reads the set back out, so it cannot be turned into a leak itself.
const canary = new Set<string>();
const MIN_CANARY = 3;

// The one normal form both sides are compared in: what cleanLine makes (NFC, controls and line breaks gone), lower-cased.
const fold = (text: string): string => cleanLine(text, Infinity).toLowerCase();

/**
 * Registers strings of three or more characters that a message or stack must not contain. They are kept in the
 * normalised form (NFC, no controls, lower-cased), the form the report's text is made in.
 */
export function registerCanary(strings: Iterable<string>): void {
  for (const text of strings) {
    const folded = fold(text);
    if (folded.length >= MIN_CANARY) canary.add(folded);
  }
}

export function clearCanary(): void {
  canary.clear();
}

function touchesCanary(text: string): boolean {
  const folded = fold(text);
  for (const secret of canary) if (folded.includes(secret)) return true;
  return false;
}

// ---- Scrubbing ------------------------------------------------------------------------------------------

const CLOSERS: Record<string, string> = { '"': '"', '`': '`', "'": "'", '“': '”', '«': '»' };
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

// Replaces each quoted run with "…". An apostrophe inside a word is not a quote ("can't"). A quote that never closes
// takes the rest of the text with it: anything after it could be what the quote was about to hold.
function removeQuoted(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const closer = CLOSERS[ch];
    if (closer && !(ch === "'" && isWordChar(text[i - 1]))) {
      let end = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === closer && !(closer === "'" && isWordChar(text[j + 1]))) { end = j; break; }
      }
      out += '"…"';
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// A b=, k= or h= parameter (board id, key, host key), whatever the length of its value (the link rules in schema.ts only catch a long one).
const KEY_PARAMETER = /(?<![A-Za-z0-9])[bkh]=[^\s&#]*/gi;

/**
 * An error's message as the report may carry it: quoted runs replaced, email addresses and key parameters hidden, the
 * first line only, a meeting link refused, cut to 120 characters. Every check runs on the whole text, before the cut,
 * so a link or an address the cut would split cannot pass as a harmless fragment.
 */
export function scrubMessage(raw: string): string {
  if (looksLikeMeetingLink(raw)) return '[withheld]';
  const firstLine = cleanLine(removeQuoted(raw).split(/\r?\n/)[0], Infinity);
  if (looksLikeMeetingLink(firstLine)) return '[withheld]';
  const hidden = firstLine.replace(/\S+@\S+/g, '[email]').replace(KEY_PARAMETER, '[key]');
  if (looksLikeMeetingLink(hidden)) return '[withheld]';
  return cleanLine(hidden, LIMITS.errorMessage);
}

// ---- Reading an error -----------------------------------------------------------------------------------

const FRAME = /(https?:\/\/[^\s()@]+?):(\d{1,7}):(\d{1,7})/;

// `index-ab12cd34.js` becomes `index`: the file's name without its path, extension or hash suffix.
function frameOf(line: string, origin: string): StackFrame | null {
  const found = FRAME.exec(line);
  if (!found) return null;
  let url: URL;
  try { url = new URL(found[1]); } catch { return null; }
  if (!origin || url.origin !== origin) return null;
  const file = (url.pathname.split('/').pop() ?? '').replace(/\.(?:m?js|tsx?|jsx)$/, '').replace(/-[A-Za-z0-9_]{8}$/, '');
  return stackFrame(file, Number(found[2]), Number(found[3]));
}

function framesOf(stack: string, origin: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const frame = frameOf(line, origin);
    if (frame) frames.push(frame);
    if (frames.length === LIMITS.stackFrames) break;
  }
  return frames;
}

const isErrorObject = (value: unknown): value is Error =>
  value instanceof Error || (typeof DOMException !== 'undefined' && value instanceof DOMException);

const nameOf = (error: Error): ErrorName =>
  (ERROR_NAMES as readonly string[]).includes(error.name) ? (error.name as ErrorName) : 'other';

const defaultOrigin = (): string => (typeof location === 'undefined' ? '' : location.origin);

// ---- The ring -------------------------------------------------------------------------------------------

interface Entry { source: ErrorSource; name: ErrorName; message: string; stack: StackFrame[]; at: number }

const RING_SIZE = LIMITS.errors;
const MAX_PER_MINUTE = 20;
let ring: Entry[] = [];
let recent: number[] = [];
let installed = false;

/** Forgets every error and the install state. For tests. */
export function resetErrors(): void {
  ring = [];
  recent = [];
  installed = false;
}

export interface NoteOptions {
  /** The page's origin; only frames from it are kept. Defaults to `location.origin`. */
  origin?: string;
}

/**
 * Notes an error in the ring. Only an Error or a DOMException has its name, message and stack read; any other thing
 * thrown becomes an empty "other". Returns false when the per-minute cap dropped it.
 */
export function noteError(source: ErrorSource, error: unknown, options: NoteOptions = {}): boolean {
  const now = Date.now();
  recent = recent.filter((at) => now - at < 60_000);
  if (recent.length >= MAX_PER_MINUTE) return false;
  recent.push(now);

  let name: ErrorName = 'other';
  let message = '';
  let stack: StackFrame[] = [];
  if (isErrorObject(error)) {
    name = nameOf(error);
    const rawMessage = typeof error.message === 'string' ? error.message : '';
    const rawStack = typeof error.stack === 'string' ? error.stack : '';
    const scrubbed = touchesCanary(rawMessage) ? '[withheld]' : scrubMessage(rawMessage);
    message = touchesCanary(scrubbed) ? '[withheld]' : scrubbed;
    stack = touchesCanary(rawStack) ? [] : framesOf(rawStack, options.origin ?? defaultOrigin());
  }

  const same = ring.findIndex((e) => e.name === name && e.message === message && e.stack[0] === stack[0]);
  if (same >= 0) ring.splice(same, 1);
  ring.unshift({ source, name, message, stack, at: now });
  ring = ring.slice(0, RING_SIZE);
  return true;
}

/** The last three errors, newest first, as the report takes them. */
export function recentErrors(): ErrorInput[] {
  const now = Date.now();
  // A canary registered after an error was noted still applies to it.
  return ring.map((e) => ({
    source: e.source,
    name: e.name,
    message: cap(touchesCanary(e.message) ? '[withheld]' : e.message, 120),
    stack: e.stack.some(touchesCanary) ? [] : e.stack,
    agoSeconds: int((now - e.at) / 1000, 0, 604_800),
  }));
}

// ---- The hooks ------------------------------------------------------------------------------------------

interface Target {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface CaptureOptions {
  target: Target;
  origin?: string;
  /** Called after an error is kept, so the trouble latch can start. */
  onError?: (source: ErrorSource) => void;
}

interface ErrorEventLike { message?: unknown; filename?: unknown; error?: unknown }

/**
 * Listens for uncaught errors and unhandled rejections from our own scripts, on the app page only. Installs once;
 * the function it returns removes the listeners.
 */
export function installErrorCapture({ target, origin, onError }: CaptureOptions): () => void {
  if (installed) return () => {};
  installed = true;
  const where = origin ?? defaultOrigin();

  const onErrorEvent = (raw: unknown): void => {
    const event = (raw ?? {}) as ErrorEventLike;
    if (!event.error) return; // a resource that failed to load, or a script error the browser hides
    if (typeof event.message === 'string' && /ResizeObserver loop/.test(event.message)) return;
    if (typeof event.filename !== 'string' || !event.filename) return;
    let sameOrigin = false;
    try { sameOrigin = new URL(event.filename).origin === where; } catch { /* not a URL */ }
    if (!sameOrigin) return;
    if (noteError('error', event.error, { origin: where })) onError?.('error');
  };
  const onRejection = (raw: unknown): void => {
    const reason = (raw as { reason?: unknown } | null)?.reason;
    if (noteError('unhandledrejection', reason, { origin: where })) onError?.('unhandledrejection');
  };

  target.addEventListener('error', onErrorEvent);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onErrorEvent);
    target.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}
