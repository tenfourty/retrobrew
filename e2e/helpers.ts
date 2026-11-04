import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { expect, type BrowserContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { LOCAL_RELAY_URLS, RATE_LIMITED_RELAY_URL } from './relay/settings';

// Where the app lives under the base URL. Keep it here only.
export const APP_PATH = process.env.E2E_APP_PATH ?? '/app/';

// Every wait on the network gets this long: public relays are sometimes slow.
export const NETWORK_WAIT = 30_000;

// The kind of the app's ephemeral relay events (src/config.ts RELAY_EVENT_KIND).
export const RELAY_EVENT_KIND = 20333;

// A string that is very unlikely to turn up anywhere by chance.
export function canary(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

// Creates a meeting, closes the share step that opens straight after, and returns the share link (#b=…&k=…&h=…).
// rehearsal: true creates it from /app/#start&rehearsal, where a timebox minute lasts 10 seconds.
export async function hostMeeting(page: Page, name: string, meetingName = 'E2E meeting', { rehearsal = false } = {}): Promise<string> {
  await createMeeting(page, name, meetingName, { rehearsal });
  await page.getByRole('dialog', { name: 'Invite people' }).getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('textbox', { name: 'New topic' })).toBeVisible();
  const board = boardOf(page.url());
  hostPages.set(board, page);
  page.once('close', () => hostPages.delete(board));
  return page.url();
}

// Fills in and submits the create form, and waits for the meeting's link. The share step is left open.
export async function createMeeting(page: Page, name: string, meetingName = 'E2E meeting', { rehearsal = false } = {}): Promise<void> {
  await page.goto(rehearsal ? withRehearsal(`${APP_PATH}#start`) : APP_PATH);
  await page.getByRole('textbox', { name: 'Meeting name' }).fill(meetingName);
  await page.getByRole('textbox', { name: 'Your name' }).fill(name);
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await page.waitForFunction(() => /[#&]b=/.test(location.hash) && /[#&]k=/.test(location.hash) && /[#&]h=/.test(location.hash));
  await expect(page.getByRole('dialog', { name: 'Invite people' })).toBeVisible({ timeout: NETWORK_WAIT });
}

// Joins through a share link and waits until the facilitator's board arrives. If it doesn't, the error adds what the
// joiner's page and the facilitator's page (when hostMeeting opened it) show: their text, the values of their fields,
// and their relays' health (relayHealthOf). Nothing is recorded on the way, so a join that works costs nothing extra.
export async function joinMeeting(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('textbox', { name: 'Your name' }).fill(name);
  await page.getByRole('button', { name: 'Take part' }).click();
  try {
    await expect(page.getByRole('textbox', { name: 'New topic' })).toBeVisible({ timeout: NETWORK_WAIT });
  } catch (error) {
    const host = hostPages.get(boardOf(url));
    const shown = `${await describePage(page, 'joiner')}\n${host ? await describePage(host, 'facilitator') : 'facilitator: not opened by hostMeeting'}`;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nWhen the join timed out:\n${shown}`);
  }
}

// The facilitator's page for each meeting hostMeeting made, by board ID, for joinMeeting's failure message.
const hostPages = new Map<string, Page>();

function boardOf(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('b') ?? '';
}

async function describePage(page: Page, who: string): Promise<string> {
  if (page.isClosed()) return `${who}: page closed`;
  const shown = await page.evaluate(() => ({
    text: document.body.innerText.slice(0, 1000),
    fields: [...document.querySelectorAll('input, textarea')].map((el) => {
      const field = el as HTMLInputElement;
      return `${field.getAttribute('aria-label') ?? field.closest('label')?.textContent?.trim() ?? field.name}=${JSON.stringify(field.value)}`;
    }),
  })).catch((e: unknown) => ({ text: `unreadable: ${String(e)}`, fields: [] }));
  return `${who}: fields ${shown.fields.join(', ') || 'none'}; relays ${await relayHealthOf(page)}\n${shown.text}`;
}

// Adds a topic with Enter, which works in both phases ("Add topic", then "Add another topic"). Focus stays in the box.
export async function addTopic(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'New topic' }).fill(text);
  await page.getByRole('textbox', { name: 'New topic' }).press('Enter');
}

// The visible banner holding some text. The page's live region repeats banner text for screen readers, so
// `getByText(<banner text>)` matches both (and the region keeps the words after the banner goes), and a count of 0 or a
// strict `toBeVisible` is wrong; this scopes to the banner itself.
export function banner(page: Page, text: string): Locator {
  return page.locator('.rb-banner-text', { hasText: text });
}

export function topicCard(page: Page, text: string): Locator {
  return page.locator('article', { hasText: text });
}

// The line everyone sees for a few seconds when a time-up vote is decided. The live region says the same words, so
// look for the visible line itself.
export function outcomeLine(page: Page): Locator {
  return page.locator('.rb-outcome');
}

// Presses "Stop timer" (in the bar, the More sheet or the side panel) and confirms it in "Stop the timer?".
export async function stopTimer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Stop timer' }).click();
  await page.getByRole('dialog', { name: 'Stop the timer?' }).getByRole('button', { name: 'Stop timer' }).click();
  await expect(page.getByRole('dialog', { name: 'Stop the timer?' })).toHaveCount(0);
}

// The sheet everyone sees when a timer runs out.
export function timeUpSheet(page: Page): Locator {
  return page.getByRole('dialog', { name: "Time's up. Keep going?" });
}

// The name of a timebox or extension choice by its real length. On a rehearsal board each choice shows the meeting's
// length with the real one beneath, and is named by both ("1 min, 10 s", "20 min, 3 min 20 s"), so a test that knows the
// real length ("10 s") matches the name's end. Use it with `getByRole('button', { name: realLength('10 s') })`.
export function realLength(real: string): RegExp {
  return new RegExp(`(^|, )${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

// The picker's Start button, whose label reads the meeting's length ("Start 1 min"), not the real one.
export const START_BUTTON = /^Start \d/;

// The facilitator picks a topic to discuss from its card and starts it with one of the picker's timeboxes, by label
// by its real length ("10 s" on a rehearsal board, where a timebox minute lasts 10 seconds; the choice reads "1 min").
export async function discussTopic(page: Page, text: string, timebox: string): Promise<void> {
  await topicCard(page, text).getByRole('button', { name: /^Discuss (?!#\d+$)/ }).click();
  const picker = page.getByRole('dialog', { name: /^Discuss #\d+$/ });
  await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: realLength(timebox) }).click();
  await picker.getByRole('button', { name: START_BUTTON }).click();
  await expect(picker).toHaveCount(0);
}

// Opens the People sheet from the "{n} here" button in the top bar, if it isn't open already.
export async function openPeople(page: Page): Promise<Locator> {
  const sheet = page.getByRole('dialog', { name: 'People' });
  if (!(await sheet.isVisible())) await page.getByRole('button', { name: /^\d+ here$/ }).click();
  await expect(sheet).toBeVisible();
  return sheet;
}

// One person's row in the host's People sheet, which says how they are connected ("Direct", "Through relays"). It
// leaves the sheet open, so press Escape before using the board.
export async function connectionLine(hostPage: Page, name: string): Promise<Locator> {
  return (await openPeople(hostPage)).getByRole('listitem').filter({ hasText: name });
}

// WebRTC exists, but no ICE candidate is ever gathered, so a direct connection can never form.
// With the 'relay' policy and no TURN servers, the browser has nothing to offer.
export async function forceNoDirectPath(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    if (!Original) return;
    const blind = (config?: RTCConfiguration): RTCConfiguration => ({ ...config, iceServers: [], iceTransportPolicy: 'relay' });
    class NoDirectPath extends Original {
      constructor(config?: RTCConfiguration) {
        super(blind(config));
      }
      override setConfiguration(config?: RTCConfiguration): void {
        super.setConfiguration(blind(config));
      }
    }
    window.RTCPeerConnection = NoDirectPath;
    (window as unknown as Record<string, unknown>).webkitRTCPeerConnection = NoDirectPath;
  });
}

// A browser with no WebRTC at all.
export async function removeWebRTC(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
      try {
        delete w[key];
      } catch {
        // Not configurable: overwrite it below.
      }
      if (key in w) w[key] = undefined;
    }
  });
}

export interface WsFrame {
  url: string;
  dir: 'sent' | 'received';
  payload: string;
  // Date.now() when the test process saw the frame.
  at: number;
  // Which of the page's WebSockets, counting from 0 in the order they opened (the two relay names share a url).
  socket: number;
}

// Records every WebSocket frame the page sends and receives. Call before the page navigates.
export function recordWsFrames(page: Page): WsFrame[] {
  const frames: WsFrame[] = [];
  let sockets = 0;
  page.on('websocket', (ws) => {
    const socket = sockets++;
    const record = (dir: WsFrame['dir']) => (frame: { payload: string | Buffer }) =>
      frames.push({ url: ws.url(), socket, dir, at: Date.now(), payload: typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8') });
    ws.on('close', () => frames.push({ url: ws.url(), socket, dir: 'received', at: Date.now(), payload: '["SOCKET","closed"]' }));
    ws.on('framesent', record('sent'));
    ws.on('framereceived', record('received'));
  });
  return frames;
}

export interface NostrEvent {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
}

// The Nostr events in a set of frames: ["EVENT", event] sent, ["EVENT", subId, event] received.
export function nostrEvents(frames: WsFrame[]): Array<{ frame: WsFrame; event: NostrEvent }> {
  const out: Array<{ frame: WsFrame; event: NostrEvent }> = [];
  for (const frame of frames) {
    let message: unknown;
    try {
      message = JSON.parse(frame.payload);
    } catch {
      continue;
    }
    if (!Array.isArray(message) || message[0] !== 'EVENT') continue;
    const event = (frame.dir === 'sent' ? message[1] : message[2]) as NostrEvent | undefined;
    if (event && typeof event.kind === 'number') out.push({ frame, event });
  }
  return out;
}

// Starts watching a page for some text; the returned function gives the time (page clock, ms) it first appeared.
export async function watchForText(page: Page, text: string): Promise<() => Promise<number>> {
  const key = `__seen_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(({ key, text }) => {
    const w = window as unknown as Record<string, number | undefined>;
    const check = () => { if (w[key] === undefined && document.body.innerText.includes(text)) w[key] = Date.now(); };
    check();
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, { key, text });
  return async () => {
    const handle = await page.waitForFunction((key) => (window as unknown as Record<string, number | undefined>)[key], key, { timeout: NETWORK_WAIT });
    return (await handle.jsonValue()) as number;
  };
}

// Collects uncaught page errors, so a test can show them when it fails.
export function collectPageErrors(page: Page, who: string): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  return errors;
}

// A change to how the page treats one relay. Block and unblock rules carry a sequence number, and the latest wins.
interface RelayRule {
  seq: number;
  action: 'block' | 'unblock' | 'redirect';
  relay: string;
  to?: string;
}

// What the network hooks put on window, before any of the page's own scripts run.
interface NetworkHooks {
  freeze(): void;
  thaw(): void;
  announceResume(): void;
  closePeers(): void;
  connectedPeers(): number;
  // Report the page hidden, or visible again (which resumes it), with nothing else: no freeze, nothing closed.
  hide(): void;
  show(): void;
  // Marks the peer connections connected now, and returns how many; markedConnectedPeers counts those still connected.
  markConnectedPeers(): number;
  markedConnectedPeers(): number;
  // Closes the connected peer connections that are not marked, as a lock does, and returns how many.
  closeUnmarkedPeers(): number;
  // The peer ID this page's Trystero announced itself with (its announcements are plain JSON), or null before it has.
  peerId(): string | null;
  // Every URL the page opened a WebSocket to, in order, as the page gave it (before any redirect).
  socketUrls(): string[];
  apply(rule: RelayRule): void;
}

declare global {
  interface Window {
    __rbE2E?: NetworkHooks;
    // The host's direct peers as its Trystero room reports them (src/app/e2e-direct-peers.ts); host pages only.
    __rbDirectPeers?: () => string[];
  }
}

// Runs in the page. It installs the hooks if this is the first script to run, then applies its rules. Playwright
// doesn't promise an order for init scripts, so each one carries the installer, and rules carry sequence numbers.
// The hooks wrap WebSocket so tests can drop, block and redirect the page's sockets, and let freezePage report the
// page as hidden and close its peer connections. Blocked and frozen sockets connect to a closed port, so the page sees
// a real connection failure.
function networkHooks(rules: RelayRule[]): void {
  if (!window.__rbE2E) {
    const NativeWebSocket = window.WebSocket;
    const nativeVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')!.get!;
    const nativeHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')!.get!;
    const unreachable = 'ws://127.0.0.1:1/';
    const sockets = new Map<WebSocket, string>();
    const blocked = new Set<string>();
    const blockSeq = new Map<string, number>();
    const redirects = new Map<string, string>();
    let frozen = false;
    let hidden = false;
    let peerId: string | null = null;
    const socketUrls: string[] = [];
    // Trystero announces itself with a Nostr event whose content is JSON holding its peer ID.
    const readPeerId = (frame: unknown): void => {
      if (peerId !== null || typeof frame !== 'string') return;
      try {
        const [type, event] = JSON.parse(frame) as [unknown, { content?: unknown }];
        if (type !== 'EVENT' || typeof event?.content !== 'string') return;
        const announced = (JSON.parse(event.content) as { peerId?: unknown }).peerId;
        if (typeof announced === 'string') peerId = announced;
      } catch { /* not an announcement */ }
    };
    const key = (url: string | URL): string => {
      const u = new URL(String(url));
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    };
    const drop = (match: (relay: string) => boolean, reason: string): void => {
      for (const [socket, relay] of sockets) if (match(relay)) socket.close(4000, reason);
    };

    class HookedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const relay = key(url);
        super(frozen || blocked.has(relay) ? unreachable : redirects.get(relay) ?? url, protocols);
        socketUrls.push(String(url));
        sockets.set(this, relay);
        this.addEventListener('close', () => sockets.delete(this));
      }
      send(data: Parameters<WebSocket['send']>[0]): void {
        readPeerId(data);
        super.send(data);
      }
    }
    window.WebSocket = HookedWebSocket;
    // Peer connections run on Chromium's network thread, which a paused page does not stop, so freeze() closes them.
    // They are held weakly, so a page that never freezes does not keep the connections it has finished with alive.
    const peerConnections = new Set<WeakRef<RTCPeerConnection>>();
    const livePeerConnections = (): RTCPeerConnection[] => {
      const live: RTCPeerConnection[] = [];
      for (const ref of peerConnections) {
        const connection = ref.deref();
        if (connection && connection.connectionState !== 'closed') live.push(connection);
        else peerConnections.delete(ref);
      }
      return live;
    };
    const marked = new WeakSet<RTCPeerConnection>();
    const connectedNow = (): RTCPeerConnection[] => livePeerConnections().filter((connection) => connection.connectionState === 'connected');
    const NativePeerConnection = window.RTCPeerConnection;
    if (NativePeerConnection) {
      class HookedPeerConnection extends NativePeerConnection {
        constructor(config?: RTCConfiguration) {
          super(config);
          // Made while frozen, it is closed with the others once the page is paused: closing it here would make the
          // page's own next call on it throw.
          livePeerConnections();
          peerConnections.add(new WeakRef(this));
        }
      }
      window.RTCPeerConnection = HookedPeerConnection;
      (window as unknown as Record<string, unknown>).webkitRTCPeerConnection = HookedPeerConnection;
    }
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get(this: Document) { return hidden ? 'hidden' : nativeVisibilityState.call(this); },
    });
    Object.defineProperty(Document.prototype, 'hidden', {
      configurable: true,
      get(this: Document) { return hidden || nativeHidden.call(this); },
    });

    window.__rbE2E = {
      freeze() {
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        frozen = true;
        document.dispatchEvent(new Event('freeze'));
        drop(() => true, 'e2e: page frozen');
        for (const connection of livePeerConnections()) connection.close();
      },
      closePeers() {
        for (const connection of livePeerConnections()) connection.close();
      },
      connectedPeers() {
        return connectedNow().length;
      },
      hide() {
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
      },
      show() {
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      },
      markConnectedPeers() {
        const connections = connectedNow();
        for (const connection of connections) marked.add(connection);
        return connections.length;
      },
      markedConnectedPeers() {
        return connectedNow().filter((connection) => marked.has(connection)).length;
      },
      closeUnmarkedPeers() {
        const unmarked = connectedNow().filter((connection) => !marked.has(connection));
        for (const connection of unmarked) connection.close();
        return unmarked.length;
      },
      peerId: () => peerId,
      socketUrls: () => [...socketUrls],
      thaw() {
        frozen = false;
        hidden = false;
      },
      announceResume() {
        document.dispatchEvent(new Event('resume'));
        document.dispatchEvent(new Event('visibilitychange'));
      },
      apply(rule) {
        const relay = key(rule.relay);
        if (rule.action === 'redirect') {
          redirects.set(relay, rule.to!);
          return;
        }
        if ((blockSeq.get(relay) ?? -1) > rule.seq) return;
        blockSeq.set(relay, rule.seq);
        if (rule.action === 'unblock') {
          blocked.delete(relay);
          return;
        }
        blocked.add(relay);
        drop((other) => other === relay, 'e2e: relay blocked');
      },
    };
  }
  for (const rule of rules) window.__rbE2E!.apply(rule);
}

const hookedContexts = new WeakSet<BrowserContext>();
// Frozen pages and the CDP session that froze each one. A frozen page is paused in the debugger.
const frozenPages = new WeakMap<Page, { cdp: CDPSession; nudge: Promise<unknown> }>();
let nextRuleSeq = 0;

// Call before the context opens a page that freezePage will act on, or whose relays a test will block later.
export async function installNetworkHooks(context: BrowserContext): Promise<void> {
  if (hookedContexts.has(context)) return;
  hookedContexts.add(context);
  await context.addInitScript(networkHooks, []);
}

const NO_HOOKS = 'This page opened before installNetworkHooks(context), so its sockets are not tracked';

// Applies a rule to the context's open pages and to every page it opens later.
async function applyRule(context: BrowserContext, rule: Omit<RelayRule, 'seq'>): Promise<void> {
  const numbered: RelayRule = { ...rule, seq: nextRuleSeq++ };
  hookedContexts.add(context);
  await context.addInitScript(networkHooks, [numbered]);
  for (const page of context.pages()) {
    const frozen = frozenPages.get(page);
    if (frozen) {
      // page.evaluate would hang on a paused page, but Runtime.evaluate on the freezing session still runs.
      await evaluateOrThrow(frozen.cdp, `window.__rbE2E.apply(${JSON.stringify(numbered)})`);
      continue;
    }
    try {
      await page.evaluate(({ rule, noHooks }) => {
        if (!window.__rbE2E) throw new Error(noHooks);
        window.__rbE2E.apply(rule);
      }, { rule: numbered, noHooks: NO_HOOKS });
    } catch (error) {
      // The page navigated while we evaluated. The init script added above applies the rule to the new document.
      if (!(error instanceof Error) || !error.message.includes('Execution context was destroyed')) throw error;
    }
  }
}

// Runtime.evaluate reports a script exception in its result instead of rejecting, so check for it.
async function evaluateOrThrow(cdp: CDPSession, expression: string): Promise<void> {
  const { exceptionDetails } = await cdp.send('Runtime.evaluate', { expression });
  if (exceptionDetails) {
    throw new Error(`${expression} failed in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }
}

// Every socket to this relay fails from now on, in the context's open pages (frozen ones too) and in any it opens later.
export async function blockRelay(context: BrowserContext, url: string): Promise<void> {
  await applyRule(context, { action: 'block', relay: url });
}

// Undoes blockRelay. Sockets the block closed stay closed: the page reconnects on its own, as after a real outage.
export async function unblockRelay(context: BrowserContext, url: string): Promise<void> {
  await applyRule(context, { action: 'unblock', relay: url });
}

// Sends the context's local-relay traffic, under both names, through the rate-limited relay. Call before the context
// opens its pages. The rate-limited relay limits each client address as well as each connection, and every context
// connects from 127.0.0.1, so `ip` names the address the context appears to come from. Contexts given the same `ip`
// share its limit, like people on one Wi-Fi; by default each context gets an address of its own.
export async function useRateLimitedRelay(context: BrowserContext, ip = `context-${randomUUID()}`): Promise<void> {
  if (context.pages().length) throw new Error('Call useRateLimitedRelay(context) before the context opens a page');
  const to = `${RATE_LIMITED_RELAY_URL}/?ip=${encodeURIComponent(ip)}`;
  for (const relay of LOCAL_RELAY_URLS) await applyRule(context, { action: 'redirect', relay, to });
}

// Freezes a page as a phone does when it locks: the page turns hidden, gets a freeze event, and its WebSockets and
// peer connections close, so nothing is delivered to it. Then no script or timer runs until resumePage.
// Page.setWebLifecycleState frozen does not stop a headless page's scripts, but it does stall the debugger's pause,
// so the pause (which does the actual stopping) comes first and the lifecycle state last. After resume the page
// sees its sockets and data channels closed. It catches up through the relay, and rejoins the direct room so the closed
// direct connection forms again. Closing a connection locally fires no connectionstatechange, unlike a real lock's ICE
// timeout, but the app's resume treats both alike: a link it cares about (a participant's to the host, any of the
// host's) that was in the room when the page was hidden and is not connected at the resume makes it rejoin. The other
// page sees the link leave while it is visible, so it does not rejoin.
// While frozen, anything that runs script in the page through Playwright (evaluate, clicks, waiting for text) hangs:
// wait from the test. blockRelay and unblockRelay still work.
// If the page cannot be paused, or cannot be frozen, freezePage undoes itself and throws: the page is usable again.
export async function freezePage(page: Page, { pauseTimeout = 5000 }: { pauseTimeout?: number } = {}): Promise<void> {
  if (frozenPages.has(page)) throw new Error('freezePage: this page is already frozen');
  await page.evaluate((noHooks) => {
    if (!window.__rbE2E) throw new Error(noHooks);
    window.__rbE2E.freeze();
  }, NO_HOOKS);
  const cdp = await page.context().newCDPSession(page);
  const paused = new Promise<void>((resolve) => cdp.on('Debugger.paused', () => resolve()));
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.pause');
  // An idle page pauses only when it next runs script, so give it some. This evaluation finishes when the page resumes.
  const nudge = cdp.send('Runtime.evaluate', { expression: 'void 0' }).catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), pauseTimeout); });
  try {
    if ((await Promise.race([paused, timedOut])) === 'timeout') {
      // Undo what was done, so the page is usable and can be frozen again: no pause pending, thawed, session gone.
      await cdp.send('Debugger.disable').catch(() => undefined);
      await evaluateOrThrow(cdp, 'window.__rbE2E.thaw()').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      await page.evaluate(() => window.__rbE2E!.announceResume()).catch(() => undefined);
      throw new Error(`freezePage: the page did not pause in the debugger within ${pauseTimeout} ms`);
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    // Connections made between freeze() and the pause are closed now, while the page cannot react to it.
    await evaluateOrThrow(cdp, 'window.__rbE2E.closePeers()');
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  } catch (error) {
    // The page is paused: thaw it while it is, then let it run and drop the session.
    await evaluateOrThrow(cdp, 'window.__rbE2E.thaw()').catch(() => undefined);
    await cdp.send('Debugger.resume').catch(() => undefined);
    await nudge;
    await cdp.send('Debugger.disable').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await page.evaluate(() => window.__rbE2E!.announceResume()).catch(() => undefined);
    throw new Error(`freezePage: the page paused but could not be frozen: ${error instanceof Error ? error.message : String(error)}`);
  }
  frozenPages.set(page, { cdp, nudge });
}

// Unfreezes a page: it turns visible again, gets resume and visibilitychange events, and its sockets may reconnect.
// If thawing or resuming fails, the page stays registered as frozen so that resumePage can be called again.
export async function resumePage(page: Page): Promise<void> {
  const frozen = frozenPages.get(page);
  if (!frozen) throw new Error('resumePage: this page is not frozen');
  const { cdp, nudge } = frozen;
  // Runtime.evaluate runs while the page is paused, so it is visible and unfrozen before any queued task runs.
  await evaluateOrThrow(cdp, 'window.__rbE2E.thaw()');
  await cdp.send('Debugger.resume');
  try {
    await nudge;
    await cdp.send('Debugger.disable');
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await cdp.detach();
  } finally {
    // The page is running again, so it is no longer frozen, whatever happened to the clean-up.
    frozenPages.delete(page);
  }
  await page.evaluate(() => window.__rbE2E!.announceResume());
}

// Adds `rehearsal` to a meeting-creation link's fragment: /app/#start becomes /app/#start&rehearsal.
export function withRehearsal(url: string): string {
  const hashAt = url.indexOf('#');
  if (hashAt === -1) return `${url}#rehearsal`;
  const fragment = url.slice(hashAt + 1);
  if (fragment.split('&').includes('rehearsal')) return url;
  return fragment === '' ? `${url}rehearsal` : `${url}&rehearsal`;
}

// Fails on any serious or critical axe violation, listing each rule and the elements it found.
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
  expect(serious, `axe found serious or critical violations on ${page.url()}`).toEqual([]);
}

// Waits until no colour or shadow transition is running, so a contrast check reads the colours the eye ends up seeing. Two
// frames first: a change made just now starts its transitions at the next style update.
export async function settleTransitions(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  // A sheet fades in over 180 ms (a CSS animation): measured halfway, red text on it reads lighter than it is. Looping animations are left alone.
  await page.waitForFunction(() => document.getAnimations().every((a) =>
    !(a instanceof CSSTransition || a instanceof CSSAnimation) || a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
}

export const THEMES = ['business-light', 'business-dark', 'party-light', 'party-dark'] as const;

// Runs axe in each of the four themes, then puts the page back in the theme it was in.
export async function expectNoA11yViolationsInEveryTheme(page: Page): Promise<void> {
  const original = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (const theme of THEMES) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    // Buttons ease their colours over 120 ms; measure contrast once they have settled.
    await settleTransitions(page);
    try {
      await expectNoA11yViolations(page);
    } catch (error) {
      throw new Error(`In ${theme}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await page.evaluate((t) => { if (t) document.documentElement.setAttribute('data-theme', t); }, original);
}

// Fails on a contrast violation inside one control while the pointer hovers it or holds it down. Axe never hovers, so a
// hover or pressed colour is only checked this way. The pointer leaves before it is released, so nothing is clicked.
export async function expectContrastWhile(page: Page, target: Locator, state: 'hover' | 'active', what: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  if (state === 'active') await page.mouse.down();
  try {
    await target.evaluate((el) => el.setAttribute('data-axe-target', ''));
    await settleTransitions(page);
    const { violations } = await new AxeBuilder({ page }).include('[data-axe-target]').withRules(['color-contrast']).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.any.map((c) => c.message).join('; ')).join(', ')}`),
      `${what} while ${state === 'hover' ? 'hovered' : 'pressed'}, on ${page.url()}`).toEqual([]);
  } finally {
    await target.evaluate((el) => el.removeAttribute('data-axe-target')).catch(() => undefined);
    await page.mouse.move(0, 0);
    if (state === 'active') await page.mouse.up();
  }
}

// Every visible control is at least 44 by 44 px; fields need only be 44 px tall. Links inside sentences are exempt,
// but the app has none: every link stands on its own as a .rb-link. Anything hidden or inert is skipped.
export async function expectTapTargets(page: Page): Promise<void> {
  const small = await page.evaluate(() => {
    const controls = document.querySelectorAll<HTMLElement>('button, a[href], input:not([type=file]), select, textarea, summary, [role=tab], [role=switch]');
    const out: string[] = [];
    for (const el of controls) {
      if (el.closest('[hidden], .rb-visually-hidden, [inert]')) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const field = el.matches('input, select, textarea');
      if (box.height < 43.5 || (!field && box.width < 43.5)) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return out;
  });
  expect(small, `controls under 44 px on ${page.url()}`).toEqual([]);
}

// What one recorded frame was, for a failure message, or undefined for a frame not worth showing. Relay events are
// plain JSON frames: a heartbeat has no sealed message; "to" names a peer; a broadcast has none; e:1 asks for an echo.
function classifyFrame(f: WsFrame): string | undefined {
  let message: unknown;
  try { message = JSON.parse(f.payload); } catch { return undefined; }
  if (!Array.isArray(message)) return undefined;
  if (f.dir === 'sent' && message[0] === 'EVENT') {
    try {
      const frame = JSON.parse((message[1] as { content: string }).content) as { to?: string; d?: string; e?: number };
      return frame.d === undefined ? 'heartbeat' : frame.e ? 'ping-echo' : frame.to ? 'to-peer' : 'broadcast';
    } catch { return 'event'; /* not a relay frame */ }
  }
  if (f.dir === 'sent' && message[0] === 'REQ') return 'REQ';
  if (f.dir === 'received' && message[0] === 'OK' && message[2] === false) return 'REFUSED';
  if (message[0] === 'SOCKET') return 'SOCKET CLOSED';
  if (f.dir === 'received' && message[0] === 'CLOSED') return `CLOSED by relay: ${String(message[2])}`;
  if (f.dir === 'received' && message[0] === 'NOTICE') return `NOTICE: ${String(message[1])}`;
  return undefined;
}

// Every relay event a page sent, and every refusal, in order with the milliseconds since the first frame and the socket,
// for a failure message.
export function describeSends(frames: WsFrame[]): string {
  const start = Math.min(...frames.map((f) => f.at));
  const lines: string[] = [];
  for (const f of frames) {
    const what = classifyFrame(f);
    if (what) lines.push(`+${String(f.at - start).padStart(6)} ms (${f.at % 100000}) s${f.socket} ${what}`);
  }
  return lines.join('\n');
}

// How many frames of each class a page sent or was told, for a failure message: "to-peer 9, broadcast 3, REFUSED 0".
// A participant's commands, pings to the host's peer and hellos straight to it are its to-peer events.
export function countSends(frames: WsFrame[]): string {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const what = classifyFrame(f);
    if (what) counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return [...counts].map(([what, n]) => `${what} ${n}`).join(', ') || 'nothing';
}

// Each relay as the page's own transport sees it (connected, refused, notices, dropped, held, given up), from the hook
// that e2e builds expose (src/app/e2e-hooks.ts); "no session" before a meeting starts or after it stops.
export async function relayHealthOf(page: Page): Promise<string> {
  const health = await page.evaluate(() => (window as unknown as { __rbRelayHealth?: () => unknown[] }).__rbRelayHealth?.()).catch((e: unknown) => `unreadable: ${String(e)}`);
  if (health === undefined) return 'no session';
  if (typeof health === 'string') return health;
  return (health as Array<{ url: string; connected: boolean; refused: number; notices: number; dropped?: number; held?: number; givenUp?: boolean }>)
    .map((h) => `${h.url} ${h.connected ? 'up' : 'down'} held ${h.held ?? '?'} dropped ${h.dropped ?? '?'} givenUp ${h.givenUp ?? '?'} refused ${h.refused} notices ${h.notices}`)
    .join('; ');
}

// Console warnings of a page that match a pattern, from now on: for a failure message.
export function collectConsole(page: Page, pattern: RegExp): string[] {
  const lines: string[] = [];
  page.on('console', (m) => { if (pattern.test(m.text())) lines.push(m.text()); });
  return lines;
}

// Forces banner signals for either view, or the facilitator's starting and failed states, in this page from its next
// load on (src/app/test-hooks.ts). Only the browser battery's builds (`--mode e2e`) read the setting.
export async function forceSignals(page: Page, forced: Record<string, unknown>): Promise<void> {
  await page.addInitScript((value) => window.sessionStorage.setItem('rb-e2e-force', value), JSON.stringify(forced));
}

// Adds people to the meeting in this browser's storage until it holds `total`, so the next newcomer is refused.
export async function fillMeeting(page: Page, total: number): Promise<void> {
  await page.evaluate(async (count) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('retrobrew');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction('boards', 'readwrite');
    const boards = tx.objectStore('boards');
    const records = await new Promise<Array<{ state: { attendees: Record<string, { id: string; name: string; role: string }> } }>>((resolve) => {
      const all = boards.getAll();
      all.onsuccess = () => resolve(all.result);
    });
    for (const record of records) {
      for (let i = Object.keys(record.state.attendees).length; i < count; i++) {
        const id = `filler-${i}`;
        record.state.attendees[id] = { id, name: `Person ${i}`, role: 'guest' };
      }
      boards.put(record);
    }
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    db.close();
  }, total);
}
