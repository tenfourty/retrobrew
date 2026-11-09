import type { ParticipantSession } from '../session/participant';
import type { BannerTone } from '../ui/banner';
import { FEEDBACK_BUILT } from './feedback-gate';
import { COPY, type BannerAction, type ParticipantSignals } from './banners';

// banners.ts picks the banners and their words by the priorities in docs/product/mvp-screens.md (Connection
// states and banners); the screens decide how they look.
export const ACTION_LABEL: Record<BannerAction, string> = { reload: 'Reload', retry: 'Retry', backUp: 'Back up', dismiss: 'Dismiss', feedback: FEEDBACK_BUILT ? 'Send feedback' : '' };

type ParticipantFields = Pick<ParticipantSession, 'connection' | 'mismatch' | 'pendingFailed' | 'staleTab' | 'staleTabMessage'>;

// What participantBanner needs, from the session: every signal, so none is dropped on the way to the banner.
export function participantSignals(session: ParticipantFields, ended: boolean): ParticipantSignals {
  return {
    ended, connection: session.connection, mismatch: session.mismatch,
    pendingFailed: session.pendingFailed, staleTab: session.staleTab, staleTabMessage: session.staleTabMessage,
  };
}

const ERRORS: string[] = [COPY.reloadThisPage, COPY.askFacilitator, COPY.pendingFailed, COPY.staleTab, COPY.saveFailed];
const WARNINGS: string[] = [COPY.noRelays, COPY.hostOffline, COPY.otherBrowser, COPY.overLimits, COPY.oversize, COPY.wentWrong];

// The tone is decoration; every banner says what is wrong in words. A stale tab's other message (tooManyTabs) is an
// error too, since it also asks for a reload.
export function bannerTone(text: string, action?: BannerAction): BannerTone {
  if (ERRORS.includes(text) || action === 'reload') return 'error';
  if (WARNINGS.includes(text)) return 'warning';
  return 'info';
}
