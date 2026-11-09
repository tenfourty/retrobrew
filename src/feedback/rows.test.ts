import { describe, expect, it } from 'vitest';
import { reportRows } from './rows';
import type { FeedbackBody } from './schema';

const report: NonNullable<FeedbackBody['report']> = {
  page: 'host', role: 'facilitator', phase: 'topics', theme: 'business', scheme: 'light', buildVersion: 'abc1234', liveVersion: 'def5678',
  userAgent: 'Mozilla/5.0 Test', language: 'en-GB', viewport: { w: 360, h: 780 }, pixelRatio: 2, online: true,
  capabilities: { webrtc: true, wakeLock: null, storagePersisted: false }, connection: 'noRelays',
  relays: [{ host: 'relay.example', connected: false, refused: 1, dropped: 2, held: 3, givenUp: true }], directPeers: 2, people: 4,
  trouble: { source: 'connection', forSeconds: 40 }, uptimeSeconds: 100,
  errors: [{ source: 'error', name: 'TypeError', message: 'x is undefined', stack: ['app.js:1:2'], agoSeconds: 5 }],
};
const body = (over: Partial<FeedbackBody> = {}): FeedbackBody => ({ v: 1, kind: 'broke', message: 'm', report, contact: null, ...over });
const row = (rows: ReturnType<typeof reportRows>, label: string) => rows.find((r) => r.label === label)?.value;
const EMAIL_ROW = 'Your email (only if you entered one)';

describe('reportRows', () => {
  it('has one row for each of the readable fields, in order', () => {
    expect(reportRows(body()).map((r) => r.label)).toEqual([
      'Retrobrew version', 'Browser', 'Screen', 'Page', 'Connection', 'Relays', 'Direct links', 'Recent errors', EMAIL_ROW,
    ]);
  });
  it('reads values from the body it is given', () => {
    const rows = reportRows(body());
    expect(row(rows, 'Retrobrew version')).toContain('abc1234');
    expect(row(rows, 'Retrobrew version')).toContain('def5678');
    expect(row(rows, 'Screen')).toContain('360');
    expect(row(rows, 'Direct links')).toBe('2');
    expect(row(rows, 'Relays')).toContain('relay.example');
    expect(row(rows, 'Recent errors')).toContain('TypeError');
    expect(row(rows, 'Recent errors')).toContain('x is undefined');
    expect(row(rows, 'Recent errors')).toContain('app.js:1:2');
  });
  it('says none when there is nothing to show', () => {
    const rows = reportRows(body({ report: { ...report, relays: [], errors: [], liveVersion: null } }));
    expect(row(rows, 'Relays')).toBe('None');
    expect(row(rows, 'Recent errors')).toBe('None');
  });
  it('shows the email only when one was entered', () => {
    expect(row(reportRows(body()), EMAIL_ROW)).toBe('None entered');
    expect(row(reportRows(body({ contact: { email: 'a@b.co' } })), EMAIL_ROW)).toBe('a@b.co');
  });
  it('says so when no report could be prepared', () => {
    expect(reportRows(body({ report: null })).map((r) => r.label)).toEqual(['Report', EMAIL_ROW]);
  });
});
