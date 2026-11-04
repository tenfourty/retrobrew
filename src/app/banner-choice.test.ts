import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../engine/messages';
import { COPY, participantBanner } from './banners';
import { bannerTone, participantSignals } from './banner-choice';

const calm = {
  connection: 'connected' as const, mismatch: null, pendingFailed: false, staleTab: false, staleTabMessage: null,
};

describe('participantSignals', () => {
  it('passes every signal from the session to the banner', () => {
    expect(participantSignals(calm, false)).toEqual({ ended: false, ...calm });
    expect(participantBanner(participantSignals(calm, false))).toBeNull();
    expect(participantBanner(participantSignals({ ...calm, connection: 'noRelays' }, false))).toEqual({ text: COPY.noRelays });
    expect(participantBanner(participantSignals({ ...calm, connection: 'hostOffline' }, false))).toEqual({ text: COPY.hostOffline });
    expect(participantBanner(participantSignals({ ...calm, mismatch: 'reloadThisPage' }, false))).toEqual({ text: COPY.reloadThisPage, action: 'reload' });
    expect(participantBanner(participantSignals({ ...calm, mismatch: 'askFacilitator' }, false))).toEqual({ text: COPY.askFacilitator });
    expect(participantBanner(participantSignals({ ...calm, pendingFailed: true }, false))).toEqual({ text: COPY.pendingFailed, action: 'retry' });
    expect(participantBanner(participantSignals({ ...calm, staleTab: true }, false))).toEqual({ text: COPY.staleTab, action: 'reload' });
  });

  it("shows tooManyTabs's message on a stale tab, and nothing on an ended meeting", () => {
    const tooMany = MESSAGES.tooManyTabs;
    expect(participantBanner(participantSignals({ ...calm, staleTab: true, staleTabMessage: tooMany }, false))).toEqual({ text: tooMany, action: 'reload' });
    expect(participantBanner(participantSignals({ ...calm, connection: 'noRelays' }, true))).toBeNull();
  });
});

describe('bannerTone', () => {
  it('marks failures as errors, connection trouble as warnings, and the rest as information', () => {
    expect(bannerTone(COPY.saveFailed)).toBe('error');
    expect(bannerTone(COPY.pendingFailed)).toBe('error');
    expect(bannerTone(MESSAGES.tooManyTabs, 'reload')).toBe('error');
    expect(bannerTone(COPY.hostOffline)).toBe('warning');
    expect(bannerTone(COPY.noRelays)).toBe('warning');
    expect(bannerTone(COPY.overLimits)).toBe('warning');
    expect(bannerTone(COPY.oversize)).toBe('warning');
    expect(bannerTone(COPY.storageNotice)).toBe('info');
  });
});
