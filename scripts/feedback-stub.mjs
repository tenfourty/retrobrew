// A stand-in for the feedback endpoint, for `npm run dev` and the browser battery (`--mode e2e`) only.
// It checks bodies with the real validator (src/feedback/schema.ts), keeps them in memory and answers like the service will.
// vite.config.ts mounts it as middleware when the build flag says stub; no production build carries it.
// Test routes: GET /__feedback (the bodies received), POST /__feedback/mode {"mode":"accept|fail|slow|ratelimit"},
// DELETE /__feedback (forget the bodies and go back to accept).
import { validateBody } from '../src/feedback/schema.ts';

export const MODES = ['accept', 'fail', 'slow', 'ratelimit'];
const MAX_BYTES = 16_384;
const KEEP = 200;

function reply(res, status, json) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(json));
}

// Reads at most `max` bytes; resolves null if the body is longer.
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) { resolve(null); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(size > max ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Returns a Connect-style middleware and the stub's state. `slowMs` is how long mode `slow` waits before answering 202. */
export function createFeedbackStub({ slowMs = 4000 } = {}) {
  const state = { mode: 'accept', received: [] };

  async function handle(req, res, next) {
    const path = (req.url ?? '').split('?')[0];
    try {
      if (path === '/__feedback') {
        if (req.method === 'GET') return reply(res, 200, { mode: state.mode, received: state.received });
        if (req.method === 'DELETE') { state.received = []; state.mode = 'accept'; return reply(res, 200, { ok: true }); }
        return reply(res, 405, { error: 'method' });
      }
      if (path === '/__feedback/mode') {
        if (req.method !== 'POST') return reply(res, 405, { error: 'method' });
        const text = await readBody(req, 1024);
        const mode = text === null ? undefined : JSON.parse(text).mode;
        if (!MODES.includes(mode)) return reply(res, 400, { error: 'mode' });
        state.mode = mode;
        return reply(res, 200, { mode });
      }
      if (path !== '/feedback') return next();
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return reply(res, 405, { error: 'method' }); }
      if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return reply(res, 415, { error: 'type' });
      const text = await readBody(req, MAX_BYTES);
      if (text === null) return reply(res, 413, { error: 'too_large' });
      let parsed;
      try { parsed = JSON.parse(text); } catch { return reply(res, 400, { error: 'invalid' }); }
      if (!validateBody(parsed).ok) return reply(res, 400, { error: 'invalid' });
      // The forced modes apply to a valid report; the body is kept only when the stub accepts it.
      if (state.mode === 'fail') return reply(res, 500, { error: 'failed' });
      if (state.mode === 'ratelimit') { res.setHeader('retry-after', '60'); return reply(res, 429, { error: 'limited' }); }
      if (state.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, slowMs));
      state.received.push(text);
      if (state.received.length > KEEP) state.received.shift();
      return reply(res, 202, { ok: true });
    } catch {
      return reply(res, 400, { error: 'invalid' });
    }
  }

  return { handle, state };
}
