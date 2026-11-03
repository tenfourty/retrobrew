import { describe, expect, it } from 'vitest';
import { connectingCopy, COPY, hostBanner, OUTCOME_MS, participantBanner, type ParticipantSignals } from './banners';

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

describe('connectingCopy', () => {
  it('waits 15 s before offering Retry, and adds advice about the link at 60 s', () => {
    expect(connectingCopy(14_999)).toEqual({ lines: ['Connecting to the facilitator…'], retry: false });
    expect(connectingCopy(15_000)).toEqual({ lines: [COPY.stillTrying], retry: true });
    expect(connectingCopy(60_000)).toEqual({ lines: [COPY.stillTrying, COPY.checkLink], retry: true });
  });
});

describe('banners added after review', () => {
  const calm = { connection: 'connected', saveFailed: false, overLimits: false, oversize: false } as const;

  it('put a refused persistence promise between a failed save and a board over the limits, with Dismiss', () => {
    expect(hostBanner({ ...calm, saveFailed: true, persistenceRefused: true, overLimits: true })).toEqual({ text: COPY.saveFailed, action: 'backUp' });
    expect(hostBanner({ ...calm, persistenceRefused: true, overLimits: true }))
      .toEqual({ text: "This browser hasn't promised to keep this meeting. Back up the meeting file when you finish, and don't use a private window.", action: 'dismiss' });
    expect(hostBanner({ ...calm, persistenceRefused: false, overLimits: true })).toEqual({ text: COPY.overLimits });
  });

  it('show tooManyTabs’s message when that was the refusal, and keep the outcome line for 5 s', () => {
    const tooMany = 'This meeting is open in too many tabs on this device. Reload this page to carry on';
    expect(participantBanner({ ...quiet, staleTab: true, staleTabMessage: tooMany })).toEqual({ text: tooMany, action: 'reload' });
    expect(OUTCOME_MS).toBe(5000);
  });
});
