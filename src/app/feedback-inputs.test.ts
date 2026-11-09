import { describe, expect, it } from 'vitest';
import { buildReport } from '../feedback/collect';
import { personText } from '../feedback/inputs';
import { feedbackInputs, NO_MEETING, reportPhase, type BrowserFacts, type PageContext } from './feedback-inputs';

describe('reportPhase', () => {
  it('names the engine phases the way the report does', () => {
    expect(reportPhase('topics')).toBe('topics');
    expect(reportPhase('discussion')).toBe('discussing');
    expect(reportPhase('ended')).toBe('ended');
  });
});

const facts: BrowserFacts = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0', language: 'en-GB', width: 1283, height: 722, pixelRatio: 1.7, online: true,
  webrtc: true, wakeLock: true, storagePersisted: null, theme: 'party', scheme: 'dark', uptimeSeconds: 61.9,
};
const ctx: PageContext = {
  page: 'host', role: 'facilitator', phase: 'discussing', connection: 'connected', directPeers: 2, people: 3,
  relays: [
    { url: 'wss://relay.primal.net', connected: true, refused: 1, notices: 0, dropped: 2, held: 3, givenUp: false },
    { url: 'wss://private.example.org/secret-path?token=abc', connected: false, refused: 0, notices: 0 },
  ],
};

describe('feedbackInputs', () => {
  it('turns the page context and the browser facts into a report the validator accepts', () => {
    const inputs = feedbackInputs(ctx, facts, { source: 'save', forSeconds: 12 }, []);
    const built = buildReport({ ...inputs, kind: 'broke', message: personText('The timer froze.'), email: null });
    expect(built.ok).toBe(true);
    if (!built.ok || !built.body.report) return;
    const report = built.body.report;
    expect(report).toMatchObject({
      page: 'host', role: 'facilitator', phase: 'discussing', theme: 'party', scheme: 'dark', language: 'en-GB',
      viewport: { w: 1280, h: 720 }, pixelRatio: 1.5, connection: 'connected', directPeers: 2, people: 3, uptimeSeconds: 61,
      trouble: { source: 'save', forSeconds: 12 },
    });
    expect(report.relays.map((r) => r.host)).toEqual(['relay.primal.net', 'other']);
    expect(report.relays[0]).toMatchObject({ refused: 1, dropped: 2, held: 3 });
  });

  it('never carries a relay URL outside the allow-list into the report', () => {
    const inputs = feedbackInputs(ctx, facts, null, []);
    expect(JSON.stringify(inputs)).not.toContain('private.example.org');
    expect(JSON.stringify(inputs)).not.toContain('secret-path');
  });

  it('reports a page that is not a meeting as no role, phase, connection or relays', () => {
    const inputs = feedbackInputs({ page: 'home', ...NO_MEETING }, facts, null, [], null);
    expect(inputs).toMatchObject({ page: 'home', role: 'none', phase: 'none', connection: 'none', relays: [], trouble: null, liveVersion: null });
  });
});
