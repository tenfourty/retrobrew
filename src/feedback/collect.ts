// The one place a feedback body is made. Every value comes from ReportInputs, whose types admit only checked values, and
// the object literal below lists every field there is: a field not written here cannot be sent.
import { LIMITS, looksLikeMeetingLink, normaliseEmail, normaliseMessage, validateBody, type FeedbackBody, type FeedbackReport, type Rejection } from './schema';
import type { ReportInputs } from './inputs';

export type BuildFailure = 'empty' | Rejection;

export type Built =
  | {
    ok: true;
    /** The request body, exactly. The person reads it, and this very string is sent. */
    json: string;
    /** The same body parsed back from `json`: what the readable rows are drawn from, so rows and json cannot disagree. */
    body: FeedbackBody;
    /** True when the report could not be prepared and only the message goes ("We couldn't prepare a report"). */
    reportFailed: boolean;
  }
  | { ok: false; reason: BuildFailure };

function reportOf(i: ReportInputs): FeedbackReport {
  return {
    page: i.page,
    role: i.role,
    phase: i.phase,
    theme: i.theme,
    scheme: i.scheme,
    buildVersion: i.buildVersion,
    liveVersion: i.liveVersion,
    userAgent: i.userAgent,
    language: i.language,
    viewport: { w: i.viewport.w, h: i.viewport.h },
    pixelRatio: i.pixelRatio,
    online: i.online,
    capabilities: { webrtc: i.capabilities.webrtc, wakeLock: i.capabilities.wakeLock, storagePersisted: i.capabilities.storagePersisted },
    connection: i.connection,
    relays: i.relays.slice(0, LIMITS.relays).map((r) => ({
      host: r.host, connected: r.connected, refused: r.refused, dropped: r.dropped, held: r.held, givenUp: r.givenUp,
    })),
    directPeers: i.directPeers,
    people: i.people,
    trouble: i.trouble ? { source: i.trouble.source, forSeconds: i.trouble.forSeconds } : null,
    uptimeSeconds: i.uptimeSeconds,
    errors: i.errors.slice(0, LIMITS.errors).map((e) => ({
      source: e.source, name: e.name, message: e.message, stack: e.stack.slice(0, LIMITS.stackFrames), agoSeconds: e.agoSeconds,
    })),
  };
}

/**
 * Makes the request body from the inputs and checks it with the validator the endpoint runs. A message that is empty, an
 * email that is not one, or a message that carries a meeting link is refused. A report that fails the check is left out
 * and the message goes alone.
 */
export function buildReport(inputs: ReportInputs): Built {
  const message = normaliseMessage(inputs.message);
  if (!message) return { ok: false, reason: 'empty' };
  // The link check reads the whole message, not the part the cut keeps: a link split by the cut would pass as a fragment.
  if (looksLikeMeetingLink(normaliseMessage(inputs.message, Infinity))) return { ok: false, reason: 'link' };

  let contact: FeedbackBody['contact'] = null;
  const typed = inputs.email?.trim();
  if (typed) {
    const email = normaliseEmail(typed);
    if (!email) return { ok: false, reason: 'email' };
    contact = { email };
  }

  const make = (report: FeedbackReport | null): FeedbackBody => ({ v: 1, kind: inputs.kind, message, report, contact });
  let reportFailed = false;
  let checked = validateBody(make(reportOf(inputs)));
  if (!checked.ok && checked.reason !== 'email') {
    reportFailed = true;
    checked = validateBody(make(null));
  }
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const json = JSON.stringify(checked.body);
  return { ok: true, json, body: JSON.parse(json) as FeedbackBody, reportFailed };
}
