import { buildVersion, cap, int, language, pixelRatio, relayHost, tens } from '../feedback/inputs';
import type { ErrorInput } from '../feedback/inputs';
import type { ReportConnection, ReportPage, ReportPhase, ReportRole, ReportScheme, ReportTheme } from '../feedback/schema';
import type { Trouble } from '../feedback/trouble';
import type { RelayHealth } from '../transport/types';
import type { SheetInputs } from './views/FeedbackSheet';

/** What a page tells the report about itself: named signals, nothing else (no board, no link, no name). */
export interface PageContext {
  page: ReportPage;
  role: ReportRole;
  phase: ReportPhase;
  connection: ReportConnection;
  relays: readonly RelayHealth[];
  directPeers: number;
  people: number;
}

/** What the browser says about itself, read in one place so the report can be built from a fake in a test. */
export interface BrowserFacts {
  userAgent: string;
  language: string;
  width: number;
  height: number;
  pixelRatio: number;
  online: boolean;
  webrtc: boolean | null;
  wakeLock: boolean | null;
  storagePersisted: boolean | null;
  theme: ReportTheme;
  scheme: ReportScheme;
  uptimeSeconds: number;
}

export function browserFacts(): BrowserFacts {
  const root = document.documentElement.getAttribute('data-theme') ?? '';
  const dark = root ? root.endsWith('dark') : Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio,
    online: navigator.onLine,
    webrtc: typeof RTCPeerConnection !== 'undefined',
    wakeLock: 'wakeLock' in navigator,
    storagePersisted: null,
    theme: root.startsWith('party') ? 'party' : 'business',
    scheme: dark ? 'dark' : 'light',
    uptimeSeconds: performance.now() / 1000,
  };
}

/**
 * The one place in src/app/ that builds the report's inputs. It reads the page's named signals and the browser's facts
 * and passes no object it did not list.
 */
export function feedbackInputs(
  ctx: PageContext,
  facts: BrowserFacts,
  trouble: Trouble | null,
  errors: ErrorInput[],
  liveVersion: ReturnType<typeof buildVersion> | null = null,
): SheetInputs {
  return {
    page: ctx.page,
    role: ctx.role,
    phase: ctx.phase,
    theme: facts.theme,
    scheme: facts.scheme,
    buildVersion: buildVersion(__RB_REVISION__),
    liveVersion,
    userAgent: cap(facts.userAgent, 200),
    language: language(facts.language),
    viewport: { w: tens(facts.width), h: tens(facts.height) },
    pixelRatio: pixelRatio(facts.pixelRatio),
    online: facts.online,
    capabilities: { webrtc: facts.webrtc, wakeLock: facts.wakeLock, storagePersisted: facts.storagePersisted },
    connection: ctx.connection,
    relays: ctx.relays.map((r) => ({
      host: relayHost(r.url),
      connected: r.connected,
      refused: int(r.refused, 0, 9999),
      dropped: int(r.dropped ?? 0, 0, 9999),
      held: int(r.held ?? 0, 0, 9999),
      givenUp: Boolean(r.givenUp),
    })),
    directPeers: int(ctx.directPeers, 0, 999),
    people: int(ctx.people, 0, 999),
    trouble: trouble ? { source: trouble.source, forSeconds: int(trouble.forSeconds, 0, 86_400) } : null,
    uptimeSeconds: int(facts.uptimeSeconds, 0, 604_800),
    errors,
  };
}

/** What a page that is not a meeting reports about itself. */
export const NO_MEETING: Omit<PageContext, 'page'> = { role: 'none', phase: 'none', connection: 'none', relays: [], directPeers: 0, people: 0 };

/** The engine's phase named the way the report names it. */
export function reportPhase(phase: 'topics' | 'discussion' | 'ended'): ReportPhase {
  return phase === 'discussion' ? 'discussing' : phase;
}
