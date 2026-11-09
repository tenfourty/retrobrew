import { describe, expect, it } from 'vitest';
import { TroubleLatch } from '../feedback/trouble';
import { COPY } from './banners';
import { bannerOffersFeedback } from './feedback-banner';

describe('bannerOffersFeedback', () => {
  it('adds the action to the network and save banners once the latch has the matching trouble', () => {
    const latch = new TroubleLatch();
    const has = (source: 'startup' | 'save' | 'connection' | 'error') => latch.has(source);
    expect(bannerOffersFeedback(COPY.saveFailed, has)).toBe(false);
    latch.set('save', true);
    expect(bannerOffersFeedback(COPY.saveFailed, has)).toBe(true);
    expect(bannerOffersFeedback(COPY.noRelays, has)).toBe(false);
    latch.set('connection', true);
    expect(bannerOffersFeedback(COPY.noRelays, has)).toBe(true);
    latch.dispose();
  });

  it('adds it to no other banner: not to the facilitator being away, a version mismatch or the storage notice', () => {
    const all = () => true;
    for (const text of [COPY.hostOffline, COPY.reloadThisPage, COPY.askFacilitator, COPY.storageNotice, COPY.otherBrowser, COPY.wentWrong]) {
      expect(bannerOffersFeedback(text, all), text).toBe(false);
    }
  });
});
