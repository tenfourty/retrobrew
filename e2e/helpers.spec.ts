import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  APP_PATH, blockRelay, expectNoA11yViolations, freezePage, installNetworkHooks, resumePage, unblockRelay, useRateLimitedRelay,
  withRehearsal,
} from './helpers';
import { LOCAL_RELAY_ALIAS_URL, LOCAL_RELAY_URL, RATE_LIMITED_RELAY_URL } from './relay/settings';

// Self-tests for e2e/helpers.ts.

interface Probe {
  ticks: number;
  // The longest wait between two ticks, in ms: about 50 unless scripts stopped.
  longestGap: number;
  log: string[];
  socket?: WebSocket;
}

declare global {
  interface Window {
    probe?: Probe;
  }
}

// Starts a 50 ms ticker, records lifecycle events, and opens one socket to the relay.
async function startProbe(page: Page, relay: string): Promise<void> {
  await page.evaluate((relay) => new Promise<void>((resolve, reject) => {
    const probe: Probe = { ticks: 0, longestGap: 0, log: [] };
    window.probe = probe;
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      probe.longestGap = Math.max(probe.longestGap, now - last);
      last = now;
      probe.ticks++;
    }, 50);
    for (const type of ['visibilitychange', 'freeze', 'resume']) {
      document.addEventListener(type, () => probe.log.push(`${type}:${document.visibilityState}`));
    }
    probe.socket = new WebSocket(relay);
    probe.socket.addEventListener('open', () => resolve());
    probe.socket.addEventListener('error', () => reject(new Error(`could not open ${relay}`)));
    probe.socket.addEventListener('close', () => probe.log.push('socket closed'));
  }), relay);
}

// Opens a socket from the page and reports whether it opened or failed within 5 s.
function trySocket(page: Page, url: string): Promise<'open' | 'failed'> {
  return page.evaluate((url) => new Promise<'open' | 'failed'>((resolve) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => { resolve('open'); socket.close(); });
    socket.addEventListener('close', () => resolve('failed'));
    setTimeout(() => resolve('failed'), 5000);
  }), url);
}

test('freezePage stops scripts and drops sockets until resumePage', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const page = await context.newPage();
    await page.goto(APP_PATH);
    await startProbe(page, LOCAL_RELAY_URL);
    await freezePage(page);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await resumePage(page);

    const after = await page.evaluate(() => ({ ...window.probe!, state: window.probe!.socket!.readyState }));
    expect(after.longestGap).toBeGreaterThanOrEqual(1800);
    expect(after.log.filter((entry) => entry !== 'socket closed'))
      .toEqual(['visibilitychange:hidden', 'freeze:hidden', 'resume:visible', 'visibilitychange:visible']);
    expect(after.log).toContain('socket closed');
    expect(after.state).toBe(3 /* WebSocket.CLOSED */);
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    // Sockets work again, and scripts run.
    expect(await trySocket(page, LOCAL_RELAY_URL)).toBe('open');
    await expect.poll(() => page.evaluate(() => window.probe!.ticks)).toBeGreaterThan(after.ticks + 5);
  } finally {
    await context.close();
  }
});

// A data channel between two pages of one context, joined by passing the complete offer and answer through the test.
// `receiver` records what arrives in window.received; `sender` holds the channel in window.channel.
async function connectDataChannel(sender: Page, receiver: Page): Promise<void> {
  const offer = await sender.evaluate(async () => {
    const connection = new RTCPeerConnection({ iceServers: [] });
    const w = window as unknown as Record<string, unknown>;
    w.connection = connection;
    w.channel = connection.createDataChannel('probe');
    await connection.setLocalDescription(await connection.createOffer());
    await new Promise<void>((resolve) => {
      if (connection.iceGatheringState === 'complete') resolve();
      connection.addEventListener('icegatheringstatechange', () => connection.iceGatheringState === 'complete' && resolve());
    });
    return connection.localDescription!.toJSON();
  });
  const answer = await receiver.evaluate(async (offer) => {
    const connection = new RTCPeerConnection({ iceServers: [] });
    const w = window as unknown as Record<string, unknown>;
    w.connection = connection;
    w.received = [] as string[];
    connection.addEventListener('datachannel', (event) => {
      event.channel.addEventListener('message', (message) => (w.received as string[]).push(String(message.data)));
    });
    await connection.setRemoteDescription(offer);
    await connection.setLocalDescription(await connection.createAnswer());
    await new Promise<void>((resolve) => {
      if (connection.iceGatheringState === 'complete') resolve();
      connection.addEventListener('icegatheringstatechange', () => connection.iceGatheringState === 'complete' && resolve());
    });
    return connection.localDescription!.toJSON();
  }, offer);
  await sender.evaluate(async (answer) => {
    await (window as unknown as { connection: RTCPeerConnection }).connection.setRemoteDescription(answer);
  }, answer);
  await expect.poll(() => sender.evaluate(() => (window as unknown as { channel: RTCDataChannel }).channel.readyState)).toBe('open');
}

// Sends on the sender's channel and says whether the browser took the message.
const sendOnChannel = (sender: Page, text: string) => sender.evaluate((text) => {
  try {
    (window as unknown as { channel: RTCDataChannel }).channel.send(text);
    return 'sent';
  } catch {
    return 'refused';
  }
}, text);

test('freezePage closes the page\'s peer connections, so nothing is delivered until resumePage', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const sender = await context.newPage();
    const receiver = await context.newPage();
    await sender.goto(APP_PATH);
    await receiver.goto(APP_PATH);
    await connectDataChannel(sender, receiver);
    expect(await sendOnChannel(sender, 'before')).toBe('sent');
    await expect.poll(() => receiver.evaluate(() => (window as unknown as { received: string[] }).received)).toEqual(['before']);

    await freezePage(receiver);
    // The sender sees the channel go, as it would a phone that locked. That is the proof that freezePage closed the
    // receiver's connection: the browser then refuses to send, so nothing can be delivered to the frozen page.
    await expect.poll(() => sender.evaluate(() => (window as unknown as { channel: RTCDataChannel }).channel.readyState))
      .not.toBe('open');
    expect(await sendOnChannel(sender, 'during')).toBe('refused');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await resumePage(receiver);

    expect(await receiver.evaluate(() => (window as unknown as { received: string[] }).received)).toEqual(['before']);
  } finally {
    await context.close();
  }
});

test('freezePage gets a page paused every time, for pages that are busy and pages that are idle', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const busy = await context.newPage();
    await busy.goto(APP_PATH);
    await startProbe(busy, LOCAL_RELAY_URL);
    const idle = await context.newPage();
    await idle.goto('data:text/html,<title>Idle</title><p>Nothing runs here</p>');
    for (let round = 0; round < 5; round++) {
      for (const page of [busy, idle]) {
        await freezePage(page);
        await resumePage(page);
      }
    }
  } finally {
    await context.close();
  }
});

test('resumePage works on a page that ran no script while frozen', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Idle</title><p>Nothing runs here</p>');
    await freezePage(page);
    await resumePage(page);
    expect(await page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve(document.visibilityState), 50)))).toBe('visible');
  } finally {
    await context.close();
  }
});

test('a failed thaw leaves the page frozen but recoverable', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Idle</title><p>Nothing runs here</p>');
    await freezePage(page);
    // A second CDP session can still run script in the paused page. Make thaw throw, once.
    const other = await context.newCDPSession(page);
    await other.send('Runtime.evaluate', {
      expression: 'window.__realThaw = window.__rbE2E.thaw; window.__rbE2E.thaw = () => { throw new Error("thaw broke"); }',
    });
    await expect(resumePage(page)).rejects.toThrow('thaw broke');
    // Still registered as frozen: it is not "not frozen", and freezing again is refused.
    await expect(freezePage(page)).rejects.toThrow('already frozen');
    await other.send('Runtime.evaluate', { expression: 'window.__rbE2E.thaw = window.__realThaw' });
    await other.detach();
    await resumePage(page);
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  } finally {
    await context.close();
  }
});

// Makes the context's CDP sessions answer some calls without sending them: 'drop' resolves with nothing, 'refuse'
// rejects. Returns the function that undoes it.
function interceptCdp(context: BrowserContext, rule: (method: string, params?: object) => 'drop' | 'refuse' | undefined): () => void {
  const newCDPSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (target) => {
    const session = await newCDPSession(target);
    const send = session.send.bind(session) as (method: string, params?: object) => Promise<unknown>;
    session.send = ((method: string, params?: object) => {
      const verdict = rule(method, params);
      if (verdict === 'drop') return Promise.resolve();
      if (verdict === 'refuse') return Promise.reject(new Error(`${method} refused`));
      return send(method, params);
    }) as typeof session.send;
    return session;
  };
  return () => { context.newCDPSession = newCDPSession; };
}

test('freezePage that gets no pause undoes itself, clears the pending pause and says why', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Idle</title><p>Nothing runs here</p>');
    // Swallow the nudge, so the idle page runs no script and the requested pause stays pending however long it takes.
    const restore = interceptCdp(context, (method, params) => (
      method === 'Runtime.evaluate' && (params as { expression?: string })?.expression === 'void 0' ? 'drop' : undefined
    ));
    try {
      await expect(freezePage(page, { pauseTimeout: 200 })).rejects.toThrow('did not pause in the debugger within 200 ms');
    } finally {
      restore();
    }
    // The undo cleared the pending pause: the page runs script instead of pausing at it. It is visible and can be frozen.
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    await freezePage(page);
    await resumePage(page);
  } finally {
    await context.close();
  }
});

test('freezePage that cannot freeze a paused page undoes itself and says why', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Idle</title><p>Nothing runs here</p>');
    const restore = interceptCdp(context, (method) => (method === 'Page.setWebLifecycleState' ? 'refuse' : undefined));
    try {
      await expect(freezePage(page)).rejects.toThrow('could not be frozen: Page.setWebLifecycleState refused');
    } finally {
      restore();
    }
    // The page was paused when the freeze failed, and runs again: script works, it is visible, and it can be frozen.
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    await freezePage(page);
    await resumePage(page);
  } finally {
    await context.close();
  }
});

test('blockRelay carries on when the page navigates under it', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const page = await context.newPage();
    await page.goto('data:text/html,<title>One</title>');
    for (let i = 0; i < 20; i++) {
      await page.evaluate((n) => { setTimeout(() => { location.href = `data:text/html,<title>Page ${n}</title>`; }, 0); }, i);
      await blockRelay(context, LOCAL_RELAY_URL);
      await unblockRelay(context, LOCAL_RELAY_URL);
    }
  } finally {
    await context.close();
  }
});

test('freezePage needs the network hooks', async ({ page }) => {
  await page.goto(APP_PATH);
  await expect(freezePage(page)).rejects.toThrow('installNetworkHooks');
});

test('blockRelay fails sockets to one relay, in open pages and new ones', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const open = await context.newPage();
    await open.goto(APP_PATH);
    await startProbe(open, LOCAL_RELAY_URL);

    await blockRelay(context, LOCAL_RELAY_URL);
    await expect.poll(() => open.evaluate(() => window.probe!.log)).toContain('socket closed');
    expect(await trySocket(open, LOCAL_RELAY_URL)).toBe('failed');
    expect(await trySocket(open, `${LOCAL_RELAY_URL}/`)).toBe('failed');
    expect(await trySocket(open, RATE_LIMITED_RELAY_URL)).toBe('open');

    const later = await context.newPage();
    await later.goto(APP_PATH);
    expect(await trySocket(later, LOCAL_RELAY_URL)).toBe('failed');
    expect(await trySocket(later, RATE_LIMITED_RELAY_URL)).toBe('open');
  } finally {
    await context.close();
  }
});

test('unblockRelay undoes blockRelay, one relay name at a time', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const open = await context.newPage();
    await open.goto(APP_PATH);

    await blockRelay(context, LOCAL_RELAY_URL);
    await blockRelay(context, LOCAL_RELAY_ALIAS_URL);
    expect(await trySocket(open, LOCAL_RELAY_URL)).toBe('failed');
    expect(await trySocket(open, LOCAL_RELAY_ALIAS_URL)).toBe('failed');
    const opened = await context.newPage();
    await opened.goto(APP_PATH);

    await unblockRelay(context, LOCAL_RELAY_URL);
    expect(await trySocket(open, LOCAL_RELAY_URL)).toBe('open');
    expect(await trySocket(open, LOCAL_RELAY_ALIAS_URL)).toBe('failed');
    expect(await trySocket(opened, LOCAL_RELAY_URL)).toBe('open');
    const later = await context.newPage();
    await later.goto(APP_PATH);
    expect(await trySocket(later, LOCAL_RELAY_URL)).toBe('open');
    expect(await trySocket(later, LOCAL_RELAY_ALIAS_URL)).toBe('failed');

    // Blocking again after an unblock wins, in open and new pages alike.
    await blockRelay(context, LOCAL_RELAY_URL);
    expect(await trySocket(open, LOCAL_RELAY_URL)).toBe('failed');
    const last = await context.newPage();
    await last.goto(APP_PATH);
    expect(await trySocket(last, LOCAL_RELAY_URL)).toBe('failed');
  } finally {
    await context.close();
  }
});

test('blockRelay and unblockRelay reach a frozen page without waking it', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installNetworkHooks(context);
    const page = await context.newPage();
    await page.goto(APP_PATH);
    await startProbe(page, LOCAL_RELAY_URL);
    await freezePage(page);
    await blockRelay(context, LOCAL_RELAY_ALIAS_URL);
    await blockRelay(context, LOCAL_RELAY_URL);
    await unblockRelay(context, LOCAL_RELAY_URL);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await resumePage(page);

    expect(await page.evaluate(() => window.probe!.longestGap)).toBeGreaterThanOrEqual(800);
    expect(await trySocket(page, LOCAL_RELAY_ALIAS_URL)).toBe('failed');
    expect(await trySocket(page, LOCAL_RELAY_URL)).toBe('open');
  } finally {
    await context.close();
  }
});

test('useRateLimitedRelay sends local relay traffic through the rate limit', async ({ browser }) => {
  // Fake events are enough: the proxy refuses on the count alone, before the relay checks signatures.
  const burst = (page: Page) => page.evaluate((relay) => new Promise<string[]>((resolve) => {
    const replies: string[] = [];
    const socket = new WebSocket(relay);
    socket.addEventListener('message', (m) => replies.push(String(m.data)));
    socket.addEventListener('open', () => {
      for (let i = 0; i < 8; i++) socket.send(JSON.stringify(['EVENT', { id: `fake${i}` }]));
      setTimeout(() => { socket.close(); resolve(replies); }, 1000);
    });
  }), LOCAL_RELAY_URL);
  const limited = await browser.newContext();
  const plain = await browser.newContext();
  try {
    await useRateLimitedRelay(limited);
    const limitedPage = await limited.newPage();
    await limitedPage.goto(APP_PATH);
    const plainPage = await plain.newPage();
    await plainPage.goto(APP_PATH);

    expect((await burst(limitedPage)).some((reply) => reply.includes('rate-limited:'))).toBe(true);
    expect((await burst(plainPage)).some((reply) => reply.includes('rate-limited:'))).toBe(false);
    await expect(useRateLimitedRelay(limited)).rejects.toThrow('before the context opens a page');
  } finally {
    await limited.close();
    await plain.close();
  }
});

test('expectNoA11yViolations fails on serious violations and passes a clean page', async ({ page }) => {
  await page.setContent('<!doctype html><html lang="en-GB"><head><title>Clean</title></head><body><main><h1>Clean</h1></main></body></html>');
  await expectNoA11yViolations(page);

  await page.setContent('<!doctype html><html lang="en-GB"><head><title>Broken</title></head><body><main><h1>Broken</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></body></html>');
  await expect(expectNoA11yViolations(page)).rejects.toThrow('image-alt');
});

test('withRehearsal adds rehearsal to the fragment once', () => {
  expect(withRehearsal('/app/#start')).toBe('/app/#start&rehearsal');
  expect(withRehearsal('http://localhost:4180/app/#start')).toBe('http://localhost:4180/app/#start&rehearsal');
  expect(withRehearsal('/app/#start&rehearsal')).toBe('/app/#start&rehearsal');
  expect(withRehearsal('/app/#')).toBe('/app/#rehearsal');
  expect(withRehearsal('/app/')).toBe('/app/#rehearsal');
});
