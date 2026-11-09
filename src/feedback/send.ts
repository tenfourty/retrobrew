// The request to the feedback endpoint. Nothing calls this until the person presses Send.
import { buildVersion, type BuildVersion } from './inputs';

/** Where the report goes: the same origin, so no CORS preflight and no new host for the CSP. */
export const FEEDBACK_PATH = '/feedback';
const VERSION_PATH = '/version.txt';
export const SEND_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 3000;

/** Why a send failed, in the terms the sheet's lines use. */
export type SendFailure = 'rate' | 'rejected' | 'timeout' | 'failed';
export type SendResult = { ok: true } | { ok: false; reason: SendFailure };

export interface SendOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

// Runs a request with a time limit; reports whether the limit was what ended it.
async function limited(
  run: (signal: AbortSignal) => Promise<Response>,
  ms: number,
): Promise<{ response: Response } | { error: 'timeout' | 'failed' }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  try {
    return { response: await run(controller.signal) };
  } catch {
    return { error: timedOut ? 'timeout' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** Posts the body string. It is the very string the person read, byte for byte. */
export async function sendFeedback(body: string, options: SendOptions = {}): Promise<SendResult> {
  const doFetch = options.fetch ?? fetch;
  const outcome = await limited((signal) => doFetch(FEEDBACK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal,
  }), options.timeoutMs ?? SEND_TIMEOUT_MS);
  if ('error' in outcome) return { ok: false, reason: outcome.error };
  const { status } = outcome.response;
  if (status === 200 || status === 202) return { ok: true };
  if (status === 429) return { ok: false, reason: 'rate' };
  if (status === 400 || status === 413) return { ok: false, reason: 'rejected' };
  return { ok: false, reason: 'failed' };
}

/** The build the site serves now (first seven digits of /version.txt), so a report can show a stale tab. Null if unknown. */
export async function fetchLiveVersion(options: SendOptions = {}): Promise<BuildVersion | null> {
  const doFetch = options.fetch ?? fetch;
  const outcome = await limited((signal) => doFetch(VERSION_PATH, {
    cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
  }), options.timeoutMs ?? VERSION_TIMEOUT_MS);
  if ('error' in outcome || !outcome.response.ok) return null;
  try {
    const text = (await outcome.response.text()).trim();
    if (text === 'dev' || text === 'unknown') return buildVersion(text);
    return /^[0-9a-f]{7,40}$/.test(text) ? buildVersion(text.slice(0, 7)) : null;
  } catch {
    return null;
  }
}
