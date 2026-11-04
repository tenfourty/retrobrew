import { MESSAGES } from '../engine/messages';
import type { Connection } from '../session/participant';
import { VERSION_MESSAGE } from '../protocol/version';

// The words and the order of the connection banners and the connecting panel (docs/product/mvp-screens.md,
// Connection states and banners). The meeting screens (sub-plan 5) decide how they look.
export const COPY = {
  reloadThisPage: VERSION_MESSAGE,
  askFacilitator: 'This meeting is running on an older version of Retrobrew. Ask the facilitator to reload their page.',
  noRelays: "Can't reach the meeting network. Check your connection.",
  hostOffline: "The facilitator's device is offline. You can still read the board, and it updates when they're back.",
  pendingFailed: "Your last change didn't reach the facilitator.",
  staleTab: MESSAGES.staleTab,
  storageNotice: 'Make a backup now and then: this browser may clear saved meetings when space runs low',
  saveFailed: "This device couldn't save the meeting. Keep this page open and back up the meeting file.",
  otherBrowser: 'This meeting is also open as facilitator in another browser. Close it in one of them, or changes made in each will not match.',
  oversize: "This meeting is too big to send to everyone in one go. It runs as normal, but new topics and people can't be added until some topics are deleted.",
  overLimits: "This meeting is bigger than Retrobrew's limits. It runs as normal, but new topics and people can't be added until some topics are deleted.",
  connecting: 'Connecting to the facilitator…',
  stillTrying: 'Still trying to reach the facilitator. They need to have the meeting open.',
  checkLink: "If it still doesn't connect, check that you opened the whole link, or ask the facilitator to send it again.",
  startFailed: "The meeting couldn't start on this device.",
} as const;

export type BannerAction = 'reload' | 'retry' | 'backUp' | 'dismiss';

// How long an outcome line shows (docs/product/mvp-screens.md, Outcome lines).
export const OUTCOME_MS = 5000;
// Moving on shows its line, with Undo beside it for the facilitator, for this long.
export const UNDO_MS = 10_000;
export const outcomeMs = (outcome: { kind: string }): number => (outcome.kind === 'movedOn' ? UNDO_MS : OUTCOME_MS);

export interface Banner {
  text: string;
  action?: BannerAction;
}

export interface ParticipantSignals {
  ended: boolean;
  connection: Connection;
  mismatch: 'reloadThisPage' | 'askFacilitator' | null;
  pendingFailed: boolean;
  staleTab: boolean;
  // tooManyTabs's message instead of staleTab's, when that was the refusal.
  staleTabMessage?: string | null;
}

// The one connection banner a participant sees, highest priority first. On an ended meeting the ended banner always
// wins, so there is no connection banner at all.
export function participantBanner(s: ParticipantSignals): Banner | null {
  if (s.ended) return null;
  if (s.mismatch === 'reloadThisPage') return { text: COPY.reloadThisPage, action: 'reload' };
  if (s.mismatch === 'askFacilitator') return { text: COPY.askFacilitator };
  if (s.connection === 'noRelays') return { text: COPY.noRelays };
  if (s.connection === 'hostOffline') return { text: COPY.hostOffline };
  if (s.pendingFailed) return { text: COPY.pendingFailed, action: 'retry' };
  if (s.staleTab) return { text: s.staleTabMessage ?? COPY.staleTab, action: 'reload' };
  return null;
}

export interface HostSignals {
  connection: Connection;
  saveFailed: boolean;
  // The calm storage notice, shown on every meeting this browser hosts until it is dismissed (it does not depend on what the
  // browser answered to navigator.storage.persist()).
  storageNotice?: boolean;
  overLimits: boolean;
  oversize: boolean;
  // Another page is hosting this meeting with the same key (HostSession.otherBrowser).
  otherBrowser?: boolean;
}

export function hostBanner(s: HostSignals): Banner | null {
  if (s.connection === 'noRelays') return { text: COPY.noRelays };
  if (s.saveFailed) return { text: COPY.saveFailed, action: 'backUp' };
  if (s.otherBrowser) return { text: COPY.otherBrowser };
  // Trouble with the meeting itself outranks the notice, which is always there and only advice.
  if (s.overLimits) return { text: COPY.overLimits };
  if (s.oversize) return { text: COPY.oversize };
  if (s.storageNotice) return { text: COPY.storageNotice, action: 'dismiss' };
  return null;
}

// What the connecting panel says, by time since joining: plain for 15 s, then with Retry, then with advice at 60 s.
export function connectingCopy(elapsedMs: number): { lines: string[]; retry: boolean } {
  if (elapsedMs < 15_000) return { lines: [COPY.connecting], retry: false };
  if (elapsedMs < 60_000) return { lines: [COPY.stillTrying], retry: true };
  return { lines: [COPY.stillTrying, COPY.checkLink], retry: true };
}
