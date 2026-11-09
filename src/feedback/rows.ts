// The readable rows of "The report we'll send with it". They are drawn from the parsed request body, the same object the
// JSON is made from, so the rows and the JSON cannot disagree.
import type { FeedbackBody, FeedbackReport } from './schema';

export interface ReportRow { label: string; value: string }

const EMAIL_LABEL = 'Your email (only if you entered one)';
const yesNo = (value: boolean | null): string => (value === null ? 'unknown' : value ? 'yes' : 'no');

function reportRowsOf(r: FeedbackReport): ReportRow[] {
  const version = r.liveVersion && r.liveVersion !== r.buildVersion ? `${r.buildVersion} (the site now serves ${r.liveVersion})` : r.buildVersion;
  const relays = r.relays.map((x) => `${x.host}: ${x.connected ? 'connected' : 'not connected'}, ${x.refused} refused, ${x.dropped} dropped, ${x.held} held${x.givenUp ? ', given up' : ''}`);
  const errors = r.errors.map((e) => `${e.name}: ${e.message || 'no message'}${e.stack.length ? ` (${e.stack.join(', ')})` : ''}, ${e.agoSeconds} s ago`);
  const trouble = r.trouble ? `, trouble: ${r.trouble.source} for ${r.trouble.forSeconds} s` : '';
  return [
    { label: 'Retrobrew version', value: version },
    { label: 'Browser', value: `${r.userAgent} (${r.language})` },
    { label: 'Screen', value: `${r.viewport.w} × ${r.viewport.h}, pixel ratio ${r.pixelRatio}, ${r.scheme} ${r.theme}` },
    { label: 'Page', value: `${r.page}, ${r.role}, ${r.phase}, ${r.people} here` },
    { label: 'Connection', value: `${r.connection}, ${r.online ? 'online' : 'offline'}, WebRTC ${yesNo(r.capabilities.webrtc)}${trouble}` },
    { label: 'Relays', value: relays.length ? relays.join('; ') : 'None' },
    { label: 'Direct links', value: String(r.directPeers) },
    { label: 'Recent errors', value: errors.length ? errors.join('; ') : 'None' },
  ];
}

export function reportRows(body: FeedbackBody): ReportRow[] {
  const head = body.report ? reportRowsOf(body.report) : [{ label: 'Report', value: 'None. Only your message is sent.' }];
  return [...head, { label: EMAIL_LABEL, value: body.contact ? body.contact.email : 'None entered' }];
}
