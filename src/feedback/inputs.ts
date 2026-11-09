// What the app hands collect.ts: enums, bounded integers and capped strings, nothing else.
//
// Every field of ReportInputs is a union of literals, a branded integer made by a clamping constructor, or a branded
// string made only by one of the constructors below. A free `string` cannot be assigned to any of them, so a value that
// was never checked cannot get into a report. The one free text is the person's own message, which has its own type.
import { PUBLIC_RELAYS } from '../config';
import {
  cleanLine,
  cutUnits,
  looksLikeMeetingLink,
  type ErrorName,
  type ErrorSource,
  type FeedbackKind,
  type ReportConnection,
  type ReportPage,
  type ReportPhase,
  type ReportRole,
  type ReportScheme,
  type ReportTheme,
  type TroubleSource,
} from './schema';

declare const brand: unique symbol;

/** An integer in [Lo, Hi]. Made only by `int()`. */
export type Int<Lo extends number, Hi extends number> = number & { readonly [brand]: readonly ['int', Lo, Hi] };
/** A single-line string of at most N UTF-16 units, free of controls. Made only by `cap()`. */
export type Capped<N extends number> = string & { readonly [brand]: readonly ['capped', N] };
/** A build ID: seven hex digits, "dev" or "unknown". */
export type BuildVersion = string & { readonly [brand]: 'version' };
/** A language tag such as "en" or "en-GB". */
export type Language = string & { readonly [brand]: 'language' };
/** A relay's host from the allow-list, or "other". */
export type RelayHost = string & { readonly [brand]: 'relay-host' };
/** A size in pixels, rounded to ten. */
export type Tens = number & { readonly [brand]: 'tens' };
/** A device pixel ratio, rounded to a half. */
export type PixelRatio = number & { readonly [brand]: 'ratio' };
/** One stack frame, `file:line:column`, with no path. */
export type StackFrame = string & { readonly [brand]: 'frame' };
/** What the person typed. It is shown to them in full before it is sent. */
export type PersonText = string & { readonly [brand]: 'person' };

export function int<Lo extends number, Hi extends number>(value: number, lo: Lo, hi: Hi): Int<Lo, Hi> {
  const n = Number.isFinite(value) ? Math.floor(value) : lo;
  return Math.min(hi, Math.max(lo, n)) as Int<Lo, Hi>;
}

/** Cleans and cuts. A text that looks like a meeting link before the cut becomes "[withheld]", never a split fragment. */
export function cap<N extends number>(text: string, max: N): Capped<N> {
  const whole = cleanLine(text, Infinity);
  return cutUnits(looksLikeMeetingLink(whole) ? '[withheld]' : whole, max) as Capped<N>;
}

export const personText = (text: string): PersonText => text as PersonText;

export function buildVersion(raw: string): BuildVersion {
  return (/^(?:dev|unknown|[0-9a-f]{7})$/.test(raw) ? raw : 'unknown') as BuildVersion;
}

/** The language and, if there is one, its region: "zh-Hans-CN" becomes "zh-Hans"; anything odd becomes "und". */
export function language(raw: string): Language {
  const [first, second] = raw.split('-');
  const tag = second ? `${first}-${second}` : first;
  return (/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(tag) ? tag : 'und') as Language;
}

/** The relay's host when it is one of the built-in relays, else "other". */
export function relayHost(url: string, allowed: readonly string[] = PUBLIC_RELAYS): RelayHost {
  const hostOf = (u: string) => /^wss?:\/\/([^/:?#]+)/i.exec(u.trim())?.[1]?.toLowerCase();
  const host = hostOf(url);
  const known = allowed.map(hostOf);
  return (host && known.includes(host) ? host : 'other') as RelayHost;
}

export function tens(value: number): Tens {
  return (Number.isFinite(value) ? Math.min(9990, Math.max(0, Math.round(value / 10) * 10)) : 0) as Tens;
}

export function pixelRatio(value: number): PixelRatio {
  return (Number.isFinite(value) ? Math.min(8, Math.max(0.5, Math.round(value * 2) / 2)) : 1) as PixelRatio;
}

export function stackFrame(file: string, line: number, column: number): StackFrame | null {
  const frame = `${file}:${line}:${column}`;
  return /^[A-Za-z0-9_.-]{1,40}:[0-9]{1,6}:[0-9]{1,6}$/.test(frame) ? (frame as StackFrame) : null;
}

export interface ErrorInput {
  source: ErrorSource;
  name: ErrorName;
  message: Capped<120>;
  stack: StackFrame[];
  agoSeconds: Int<0, 604800>;
}

export interface RelayInput {
  host: RelayHost;
  connected: boolean;
  refused: Int<0, 9999>;
  dropped: Int<0, 9999>;
  held: Int<0, 9999>;
  givenUp: boolean;
}

export interface ReportInputs {
  kind: FeedbackKind;
  message: PersonText;
  /** What the person typed in the optional email field, or null when it is empty. */
  email: PersonText | null;
  page: ReportPage;
  role: ReportRole;
  phase: ReportPhase;
  theme: ReportTheme;
  scheme: ReportScheme;
  buildVersion: BuildVersion;
  liveVersion: BuildVersion | null;
  userAgent: Capped<200>;
  language: Language;
  viewport: { w: Tens; h: Tens };
  pixelRatio: PixelRatio;
  online: boolean;
  capabilities: { webrtc: boolean | null; wakeLock: boolean | null; storagePersisted: boolean | null };
  connection: ReportConnection;
  relays: RelayInput[];
  directPeers: Int<0, 999>;
  people: Int<0, 999>;
  trouble: { source: TroubleSource; forSeconds: Int<0, 86400> } | null;
  uptimeSeconds: Int<0, 604800>;
  errors: ErrorInput[];
}
