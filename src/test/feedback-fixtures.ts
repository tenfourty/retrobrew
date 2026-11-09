import type { FeedbackBody, FeedbackReport } from '../feedback/schema';

// A full, valid report and body. Every call returns fresh objects, so a test may change them.
export const sampleReport = (): FeedbackReport => ({
  page: 'host',
  role: 'facilitator',
  phase: 'topics',
  theme: 'business',
  scheme: 'light',
  buildVersion: '0123abc',
  liveVersion: '0123abc',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0',
  language: 'en-GB',
  viewport: { w: 1280, h: 720 },
  pixelRatio: 1.5,
  online: true,
  capabilities: { webrtc: true, wakeLock: null, storagePersisted: false },
  connection: 'connected',
  relays: [{ host: 'relay.primal.net', connected: true, refused: 0, dropped: 0, held: 0, givenUp: false }],
  directPeers: 2,
  people: 3,
  trouble: { source: 'save', forSeconds: 12 },
  uptimeSeconds: 600,
  errors: [{ source: 'error', name: 'TypeError', message: 'x is not a function', stack: ['index:1:2345'], agoSeconds: 4 }],
});

export const sampleBody = (): FeedbackBody => ({ v: 1, kind: 'broke', message: 'The timer froze.', report: sampleReport(), contact: null });
