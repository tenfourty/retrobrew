import { describe, expect, it } from 'vitest';
import { connectingCopy, COPY, hostBanner, OUTCOME_MS, outcomeMs, participantBanner, UNDO_MS, type ParticipantSignals } from './banners';

const quiet: ParticipantSignals = { ended: false, connection: 'connected', mismatch: null, pendingFailed: false, staleTab: false };

describe('participantBanner', () => {
  it('shows nothing when all is well, and nothing on an ended meeting whatever else is true', () => {
    expect(participantBanner(quiet)).toBeNull();
    expect(participantBanner({ ...quiet, ended: true, connection: 'hostOffline', pendingFailed: true })).toBeNull();
  });

  it('shows the highest-priority banner: version, network, host offline, then the change that didn’t arrive', () => {
    const all: ParticipantSignals = { ended: false, connection: 'noRelays', mismatch: 'reloadThisPage', pendingFailed: true, staleTab: true };
    expect(participantBanner(all)).toEqual({ text: 'This meeting was started with a different version of Retrobrew. Reload this page.', action: 'reload' });
    expect(participantBanner({ ...all, mismatch: 'askFacilitator' })).toEqual({ text: COPY.askFacilitator });
    expect(participantBanner({ ...all, mismatch: null })).toEqual({ text: "Can't reach the meeting network. Check your connection." });
    expect(participantBanner({ ...all, mismatch: null, connection: 'hostOffline' })).toEqual({ text: COPY.hostOffline });
    expect(participantBanner({ ...all, mismatch: null, connection: 'connected' })).toEqual({ text: "Your last change didn't reach the facilitator.", action: 'retry' });
    expect(participantBanner({ ...quiet, staleTab: true })).toEqual({ text: 'This page has been away too long. Reload it to carry on', action: 'reload' });
  });
});

describe('hostBanner', () => {
  const calm = { connection: 'connected', saveFailed: false, overLimits: false, oversize: false } as const;

  it('puts the network first, then a failed save, then a board over the limits, then an oversize bundle', () => {
    expect(hostBanner(calm)).toBeNull();
    expect(hostBanner({ connection: 'noRelays', saveFailed: true, overLimits: true, oversize: true })).toEqual({ text: COPY.noRelays });
    expect(hostBanner({ ...calm, saveFailed: true, overLimits: true, oversize: true })).toEqual({ text: COPY.saveFailed, action: 'backUp' });
    expect(hostBanner({ ...calm, overLimits: true, oversize: true })).toEqual({ text: COPY.overLimits });
    expect(hostBanner({ ...calm, oversize: true })).toEqual({ text: COPY.oversize });
  });
});

describe('the other-browser banner', () => {
  const calm = { connection: 'connected', saveFailed: false, overLimits: false, oversize: false } as const;

  it('comes after the network and a failed save and before the limits and the storage notice, with no action', () => {
    const text = 'This meeting is also open as facilitator in another browser. Close it in one of them, or changes made in each will not match.';
    expect(hostBanner({ ...calm, otherBrowser: true })).toEqual({ text });
    expect(hostBanner({ ...calm, otherBrowser: true, overLimits: true, storageNotice: true })).toEqual({ text });
    expect(hostBanner({ ...calm, otherBrowser: true, saveFailed: true })).toEqual({ text: COPY.saveFailed, action: 'backUp' });
    expect(hostBanner({ ...calm, connection: 'noRelays', otherBrowser: true })).toEqual({ text: COPY.noRelays });
  });
});

describe('connectingCopy', () => {
  it('waits 15 s before offering Retry, and adds advice about the link at 60 s', () => {
    expect(connectingCopy(14_999)).toEqual({ lines: ['Connecting to the facilitator…'], retry: false });
    expect(connectingCopy(15_000)).toEqual({ lines: [COPY.stillTrying], retry: true });
    expect(connectingCopy(60_000)).toEqual({ lines: [COPY.stillTrying, COPY.checkLink], retry: true });
  });
});

describe('banners added after review', () => {
  const calm = { connection: 'connected', saveFailed: false, overLimits: false, oversize: false } as const;

  it('put the calm storage notice last, with Dismiss, below a failed save and a board over its limits', () => {
    expect(hostBanner({ ...calm, saveFailed: true, storageNotice: true, overLimits: true })).toEqual({ text: COPY.saveFailed, action: 'backUp' });
    expect(hostBanner({ ...calm, storageNotice: true, overLimits: true })).toEqual({ text: COPY.overLimits });
    expect(hostBanner({ ...calm, storageNotice: true, oversize: true })).toEqual({ text: COPY.oversize });
    expect(hostBanner({ ...calm, storageNotice: true }))
      .toEqual({ text: 'Make a backup now and then: this browser may clear saved meetings when space runs low', action: 'dismiss' });
    expect(hostBanner({ ...calm, storageNotice: false })).toBeNull();
  });

  it('show tooManyTabs’s message when that was the refusal, and keep the outcome line for 5 s', () => {
    const tooMany = 'This meeting is open in too many tabs on this device. Reload this page to carry on';
    expect(participantBanner({ ...quiet, staleTab: true, staleTabMessage: tooMany })).toEqual({ text: tooMany, action: 'reload' });
    expect(OUTCOME_MS).toBe(5000);
    expect(UNDO_MS).toBe(10_000);
    expect(outcomeMs({ kind: 'extended' })).toBe(OUTCOME_MS);
    expect(outcomeMs({ kind: 'movedOn' })).toBe(UNDO_MS);
  });
});
