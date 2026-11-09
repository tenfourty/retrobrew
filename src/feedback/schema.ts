// The feedback request: its types, limits and the one strict validator (docs/product/feedback.md).
//
// This file imports nothing, so the feedback endpoint can run the very same code as the page. A client change that
// adds a field fails here before it can reach the service, and the other way round.

// ---- Limits ---------------------------------------------------------------------------------------------

export const LIMITS = {
  message: 2000,
  email: 254,
  emailLocal: 64,
  userAgent: 200,
  errorMessage: 120,
  errors: 3,
  stackFrames: 6,
  relays: 4,
  /** The endpoint refuses a request body longer than this many bytes (UTF-8). */
  bodyBytes: 16_384,
} as const;

// ---- The fixed lists ------------------------------------------------------------------------------------

export const KINDS = ['broke', 'idea', 'other'] as const;
export const PAGES = ['home', 'host', 'participant', 'state', 'landing', 'guide'] as const;
export const ROLES = ['facilitator', 'participant', 'none'] as const;
export const PHASES = ['topics', 'discussing', 'ended', 'none'] as const;
export const THEMES = ['business', 'party'] as const;
export const SCHEMES = ['light', 'dark'] as const;
export const CONNECTIONS = ['connecting', 'connected', 'hostOffline', 'noRelays', 'versionMismatch', 'none'] as const;
export const TROUBLE_SOURCES = ['startup', 'save', 'connection', 'error'] as const;
export const ERROR_SOURCES = ['error', 'unhandledrejection', 'startup', 'save'] as const;
export const ERROR_NAMES = [
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'QuotaExceededError', 'NotAllowedError',
  'InvalidStateError', 'SecurityError', 'AbortError', 'NetworkError', 'DataError', 'ConstraintError', 'other',
] as const;

export type FeedbackKind = (typeof KINDS)[number];
export type ReportPage = (typeof PAGES)[number];
export type ReportRole = (typeof ROLES)[number];
export type ReportPhase = (typeof PHASES)[number];
export type ReportTheme = (typeof THEMES)[number];
export type ReportScheme = (typeof SCHEMES)[number];
export type ReportConnection = (typeof CONNECTIONS)[number];
export type TroubleSource = (typeof TROUBLE_SOURCES)[number];
export type ErrorSource = (typeof ERROR_SOURCES)[number];
export type ErrorName = (typeof ERROR_NAMES)[number];

// ---- The request ----------------------------------------------------------------------------------------

export interface ReportError {
  source: ErrorSource;
  name: ErrorName;
  message: string;
  /** At most six frames, each `file:line:column` of our own scripts, with no path and no hash suffix. */
  stack: string[];
  agoSeconds: number;
}

export interface ReportRelay {
  /** A relay host from src/config.ts, or "other". The page enforces the list; the pattern is all the endpoint can know. */
  host: string;
  connected: boolean;
  refused: number;
  dropped: number;
  held: number;
  givenUp: boolean;
}

export interface FeedbackReport {
  page: ReportPage;
  role: ReportRole;
  phase: ReportPhase;
  theme: ReportTheme;
  scheme: ReportScheme;
  buildVersion: string;
  liveVersion: string | null;
  userAgent: string;
  language: string;
  viewport: { w: number; h: number };
  pixelRatio: number;
  online: boolean;
  capabilities: { webrtc: boolean | null; wakeLock: boolean | null; storagePersisted: boolean | null };
  connection: ReportConnection;
  relays: ReportRelay[];
  directPeers: number;
  people: number;
  trouble: { source: TroubleSource; forSeconds: number } | null;
  uptimeSeconds: number;
  errors: ReportError[];
}

export interface FeedbackBody {
  v: 1;
  kind: FeedbackKind;
  message: string;
  /** null when the page could not prepare a report; the message still goes. */
  report: FeedbackReport | null;
  /** The optional reply address. Never inside `report`: only the owner ever sees it. */
  contact: { email: string } | null;
}

export type Rejection = 'shape' | 'chars' | 'link' | 'email';
export type Validation = { ok: true; body: FeedbackBody } | { ok: false; reason: Rejection };

// ---- Text rules -----------------------------------------------------------------------------------------

// Control characters other than tab and newline, the bidi overrides and isolates (U+202A to U+202E, U+2066 to U+2069),
// invisible characters (U+200B, U+200E, U+200F, U+061C, U+2028, U+2029, U+FEFF), and lone surrogates. A real message never needs them.
const FORBIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B\u200E\u200F\u061C\u2028\u2029\uFEFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FORBIDDEN_ALL = new RegExp(FORBIDDEN, 'g');

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
export function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The person's message as it is sent: NFC, newline kept, other controls dropped, at most 2,000 units (or `max`), trimmed.
 * Pass `Infinity` for the whole text, to check it before it is cut.
 */
export function normaliseMessage(raw: string, max: number = LIMITS.message): string {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(FORBIDDEN_ALL, '').normalize('NFC');
  return cutUnits(text, max).trim();
}

/** A single-line string for the report: NFC, no controls, no line breaks, cut to `max` units. */
export function cleanLine(raw: string, max: number): string {
  return cutUnits(raw.replace(/[\r\n\t]+/g, ' ').replace(FORBIDDEN_ALL, '').normalize('NFC'), max);
}

// Percent-decodes every valid run once; an invalid run stays as it is.
function decodeOnce(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
}

const LINK_RULES: readonly RegExp[] = [
  // A "#" followed, later, by a b= or k= parameter: the shape of a share link's fragment.
  /#[\s\S]*?(?<![A-Za-z0-9])[bk]=/,
  // A b= or k= parameter with a value as long as a board id or key.
  /(?<![A-Za-z0-9])[bk]=[A-Za-z0-9_-]{16,}/,
  // The app's own address followed by a fragment.
  /retrobrew\.app\/app[^\s#]*#/i,
];

/** True when the text looks like a meeting's share link, read raw and after up to three rounds of URL-decoding. */
export function looksLikeMeetingLink(text: string): boolean {
  let current = text;
  for (let round = 0; round <= 3; round++) {
    if (LINK_RULES.some((rule) => rule.test(current))) return true;
    const next = decodeOnce(current);
    if (next === current) return false;
    current = next;
  }
  return false;
}

// ---- The email ------------------------------------------------------------------------------------------

const EMAIL_FORBIDDEN = /[\s"'`,;:<>()[\]\\]/;
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(`^(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`);

/**
 * The address in its canonical form (trimmed, the domain lower-cased and in punycode), or null when it is not one plain
 * address. One rule for the sheet and the endpoint: no display name, no list, no quotes, no brackets, no whitespace or
 * control characters, exactly one "@", a local part in NFC of 1 to 64 UTF-8 bytes with no dot at either end and no double dot, a dotted domain whose last label has at
 * least two characters and a letter, and 254 characters at most.
 */
export function normaliseEmail(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > LIMITS.email) return null;
  if (EMAIL_FORBIDDEN.test(text) || FORBIDDEN.test(text)) return null;
  const parts = text.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (text !== text.normalize('NFC') || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (local.length < 1 || new TextEncoder().encode(local).length > LIMITS.emailLocal || !domain || /[/?#%]/.test(domain)) return null;
  let host: string;
  try {
    host = new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
  if (!DOMAIN.test(host)) return null;
  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || !/[a-z]/.test(tld)) return null;
  const email = `${local}@${host}`;
  return email.length <= LIMITS.email ? email : null;
}

// ---- The validator --------------------------------------------------------------------------------------

// No parameter property: the endpoint runs this file as it is under Node's type stripping, which allows erasable syntax only.
class Reject extends Error {
  readonly reason: Rejection;
  constructor(reason: Rejection) {
    super(reason);
    this.reason = reason;
  }
}

const shape = (): never => { throw new Reject('shape'); };

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return shape();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return shape();
  if (Object.getOwnPropertySymbols(value).length > 0) return shape();
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return shape();
  return value as Record<string, unknown>;
}

const oneOf = <T extends string>(value: unknown, list: readonly T[]): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : shape();

const int = (value: unknown, min: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : shape();

const bool = (value: unknown): boolean => (typeof value === 'boolean' ? value : shape());
const boolOrNull = (value: unknown): boolean | null => (value === null ? null : bool(value));

function text(value: unknown, max: number): string {
  return typeof value === 'string' && value.length <= max ? value : shape();
}

function pattern(value: unknown, rule: RegExp, max: number): string {
  const result = text(value, max);
  return rule.test(result) ? result : shape();
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : shape();
}

const VERSION = /^(?:dev|unknown|[0-9a-f]{7})$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const RELAY_HOST = /^(?:other|[a-z0-9](?:[a-z0-9.-]{0,60}[a-z0-9])?)$/;
const STACK_FRAME = /^[A-Za-z0-9_.-]{1,40}:[0-9]{1,6}:[0-9]{1,6}$/;

const ERROR_KEYS = ['source', 'name', 'message', 'stack', 'agoSeconds'] as const;
const RELAY_KEYS = ['host', 'connected', 'refused', 'dropped', 'held', 'givenUp'] as const;
const REPORT_KEYS = [
  'page', 'role', 'phase', 'theme', 'scheme', 'buildVersion', 'liveVersion', 'userAgent', 'language', 'viewport', 'pixelRatio',
  'online', 'capabilities', 'connection', 'relays', 'directPeers', 'people', 'trouble', 'uptimeSeconds', 'errors',
] as const;

function checkError(value: unknown): ReportError {
  const r = record(value, ERROR_KEYS);
  return {
    source: oneOf(r.source, ERROR_SOURCES),
    name: oneOf(r.name, ERROR_NAMES),
    message: text(r.message, LIMITS.errorMessage),
    stack: list(r.stack, LIMITS.stackFrames).map((frame) => pattern(frame, STACK_FRAME, 60)),
    agoSeconds: int(r.agoSeconds, 0, 604_800),
  };
}

function checkRelay(value: unknown): ReportRelay {
  const r = record(value, RELAY_KEYS);
  return {
    host: pattern(r.host, RELAY_HOST, 62),
    connected: bool(r.connected),
    refused: int(r.refused, 0, 9999),
    dropped: int(r.dropped, 0, 9999),
    held: int(r.held, 0, 9999),
    givenUp: bool(r.givenUp),
  };
}

function checkReport(value: unknown): FeedbackReport {
  const r = record(value, REPORT_KEYS);
  const viewport = record(r.viewport, ['w', 'h']);
  const caps = record(r.capabilities, ['webrtc', 'wakeLock', 'storagePersisted']);
  const ratio = r.pixelRatio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.5 || ratio > 8 || !Number.isInteger(ratio * 2)) shape();
  const tens = (n: unknown): number => {
    const v = int(n, 0, 9990);
    return v % 10 === 0 ? v : shape();
  };
  let trouble: FeedbackReport['trouble'] = null;
  if (r.trouble !== null) {
    const t = record(r.trouble, ['source', 'forSeconds']);
    trouble = { source: oneOf(t.source, TROUBLE_SOURCES), forSeconds: int(t.forSeconds, 0, 86_400) };
  }
  return {
    page: oneOf(r.page, PAGES),
    role: oneOf(r.role, ROLES),
    phase: oneOf(r.phase, PHASES),
    theme: oneOf(r.theme, THEMES),
    scheme: oneOf(r.scheme, SCHEMES),
    buildVersion: pattern(r.buildVersion, VERSION, 7),
    liveVersion: r.liveVersion === null ? null : pattern(r.liveVersion, VERSION, 7),
    userAgent: text(r.userAgent, LIMITS.userAgent),
    language: pattern(r.language, LANGUAGE, 12),
    viewport: { w: tens(viewport.w), h: tens(viewport.h) },
    pixelRatio: ratio as number,
    online: bool(r.online),
    capabilities: { webrtc: boolOrNull(caps.webrtc), wakeLock: boolOrNull(caps.wakeLock), storagePersisted: boolOrNull(caps.storagePersisted) },
    connection: oneOf(r.connection, CONNECTIONS),
    relays: list(r.relays, LIMITS.relays).map(checkRelay),
    directPeers: int(r.directPeers, 0, 999),
    people: int(r.people, 0, 999),
    trouble,
    uptimeSeconds: int(r.uptimeSeconds, 0, 604_800),
    errors: list(r.errors, LIMITS.errors).map(checkError),
  };
}

// Every string the body carries that must stay on one line.
function singleLines(report: FeedbackReport | null): string[] {
  if (!report) return [];
  return [report.userAgent, ...report.errors.map((e) => e.message)];
}

/**
 * Checks a request body strictly: the exact keys, the exact types, the patterns and the caps; nothing is repaired.
 * Returns the checked body, or the first kind of problem it found (never which rule, so a prober learns nothing).
 * It never throws.
 */
export function validateBody(input: unknown): Validation {
  try {
    const top = record(input, ['v', 'kind', 'message', 'report', 'contact']);
    if (top.v !== 1) shape();
    const kind = oneOf(top.kind, KINDS);
    const message = text(top.message, LIMITS.message);
    if (!message.trim()) shape();
    const report = top.report === null ? null : checkReport(top.report);
    let contact: FeedbackBody['contact'] = null;
    if (top.contact !== null) {
      const c = record(top.contact, ['email']);
      contact = { email: text(c.email, LIMITS.email) };
    }

    if (message !== message.normalize('NFC') || FORBIDDEN.test(message)) throw new Reject('chars');
    const lines = singleLines(report);
    for (const line of lines) if (FORBIDDEN.test(line) || /[\n\t]/.test(line) || line !== line.normalize('NFC')) throw new Reject('chars');
    if (looksLikeMeetingLink(message) || lines.some(looksLikeMeetingLink)) throw new Reject('link');
    if (contact && normaliseEmail(contact.email) !== contact.email) throw new Reject('email');

    return { ok: true, body: { v: 1, kind, message, report, contact } };
  } catch (error) {
    return { ok: false, reason: error instanceof Reject ? error.reason : 'shape' };
  }
}
