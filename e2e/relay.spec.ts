import { expect, test } from '@playwright/test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { WebSocket } from 'ws';
import { canary, RELAY_EVENT_KIND } from './helpers';
import { LOCAL_RELAY_URL, RATE_LIMIT, RATE_LIMITED_RELAY_URL } from './relay/settings';

// A bare Nostr client: the messages it received, and whether the relay closed it.
interface RelayClient {
  socket: WebSocket;
  received: unknown[][];
  closed: Promise<number>;
}

async function connect(url: string): Promise<RelayClient> {
  const socket = new WebSocket(url);
  const received: unknown[][] = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString()) as unknown[]));
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, received, closed };
}

// The rate-limited relay, as seen from one client address. Each test uses its own, so their buckets never meet.
const limitedFrom = (ip: string) => `${RATE_LIMITED_RELAY_URL}/?ip=${ip}`;

function signedEvent(topic: string, content: string) {
  return finalizeEvent({ kind: RELAY_EVENT_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', topic]], content }, generateSecretKey());
}

// Signs every event first, because signing takes a few milliseconds each and the limits refill in the meantime.
function publish(client: RelayClient, topic: string, count: number, label: string): void {
  const messages = Array.from({ length: count }, (_, i) => JSON.stringify(['EVENT', signedEvent(topic, `${label} ${i}`)]));
  for (const message of messages) client.socket.send(message);
}

// Several senders at once: all events are signed before the first is sent.
function sendAll(senders: RelayClient[], topic: string, perSender: number, label: string): void {
  const batches = senders.map((_, s) => Array.from({ length: perSender }, (_, i) => JSON.stringify(['EVENT', signedEvent(topic, `${label} ${s}.${i}`)])));
  senders.forEach((sender, s) => { for (const message of batches[s]) sender.socket.send(message); });
}

const okReplies = (client: RelayClient) => client.received.filter((m) => m[0] === 'OK');
const refusals = (client: RelayClient) => okReplies(client).filter((m) => m[2] === false && String(m[3]).startsWith('rate-limited:'));
const eventsAt = (client: RelayClient) => client.received.filter((m) => m[0] === 'EVENT').length;

// A subscriber on the local relay itself: it sees every event the proxy let through, whatever happened to the sender.
async function subscribe(topic: string): Promise<RelayClient> {
  const subscriber = await connect(LOCAL_RELAY_URL);
  subscriber.socket.send(JSON.stringify(['REQ', 'live', { kinds: [RELAY_EVENT_KIND], '#t': [topic] }]));
  await expect.poll(() => subscriber.received.some((m) => m[0] === 'EOSE')).toBe(true);
  return subscriber;
}

// Waits until no more events arrive for half a second, then returns how many arrived.
async function settledCount(subscriber: RelayClient): Promise<number> {
  let last = -1;
  while (eventsAt(subscriber) !== last) {
    last = eventsAt(subscriber);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

test('the local relay forwards ephemeral events and does not store them', async () => {
  const topic = canary('topic');
  const subscriber = await subscribe(topic);
  const publisher = await connect(LOCAL_RELAY_URL);
  try {
    publish(publisher, topic, 3, 'stored?');
    await expect.poll(() => eventsAt(subscriber)).toBe(3);
    await expect.poll(() => okReplies(publisher).map((m) => m[2])).toEqual([true, true, true]);

    const late = await connect(LOCAL_RELAY_URL);
    late.socket.send(JSON.stringify(['REQ', 'stored', { kinds: [RELAY_EVENT_KIND], '#t': [topic] }]));
    await expect.poll(() => late.received.some((m) => m[0] === 'EOSE')).toBe(true);
    expect(eventsAt(late)).toBe(0);
    late.socket.close();
  } finally {
    subscriber.socket.close();
    publisher.socket.close();
  }
});

test('the rate-limited relay refuses a burst, then disconnects the sender', async () => {
  const topic = canary('topic');
  const subscriber = await subscribe(topic);
  const sender = await connect(limitedFrom(canary('ip')));
  try {
    publish(sender, topic, RATE_LIMIT.connection.burst + RATE_LIMIT.banAfter + 5, 'burst');

    expect(await sender.closed).toBe(1008);
    expect(refusals(sender)).toHaveLength(RATE_LIMIT.banAfter);
    // The connection's burst allowance got through, plus at most one token that refilled while the burst was in flight.
    const delivered = await settledCount(subscriber);
    expect(delivered).toBeGreaterThanOrEqual(RATE_LIMIT.connection.burst);
    expect(delivered).toBeLessThanOrEqual(RATE_LIMIT.connection.burst + 1);
  } finally {
    subscriber.socket.close();
  }
});

test('the rate-limited relay accepts a sender that stays under the limit', async () => {
  const topic = canary('topic');
  const subscriber = await subscribe(topic);
  const sender = await connect(limitedFrom(canary('ip')));
  const count = RATE_LIMIT.connection.burst + 4;
  try {
    const intervalMs = Math.ceil(1000 / (RATE_LIMIT.connection.eventsPerSecond - 1));
    for (let i = 0; i < count; i++) {
      publish(sender, topic, 1, `paced ${i}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    await expect.poll(() => okReplies(sender).length).toBe(count);
    expect(okReplies(sender).every((m) => m[2] === true)).toBe(true);
    // Events through the proxy reach subscribers of the relay behind it.
    await expect.poll(() => eventsAt(subscriber)).toBe(count);
  } finally {
    subscriber.socket.close();
    sender.socket.close();
  }
});

test('connections from one address share its limit, and other addresses have their own', async () => {
  const perConnection = RATE_LIMIT.connection.burst;
  // More connections than the address allowance can carry, each sending no more than its own allowance.
  const connections = Math.ceil(RATE_LIMIT.address.burst / perConnection) + 1;
  const total = connections * perConnection;

  const sharedTopic = canary('topic');
  const shared = await subscribe(sharedTopic);
  const ip = canary('ip');
  const sameAddress = await Promise.all(Array.from({ length: connections }, () => connect(limitedFrom(ip))));
  sendAll(sameAddress, sharedTopic, perConnection, 'shared');
  const sharedDelivered = await settledCount(shared);
  expect(sharedDelivered).toBeGreaterThanOrEqual(RATE_LIMIT.address.burst);
  expect(sharedDelivered).toBeLessThanOrEqual(RATE_LIMIT.address.burst + 1);
  await expect.poll(() => sameAddress.reduce((sum, sender) => sum + refusals(sender).length, 0)).toBe(total - sharedDelivered);

  const ownTopic = canary('topic');
  const own = await subscribe(ownTopic);
  const ownAddresses = await Promise.all(Array.from({ length: connections }, () => connect(limitedFrom(canary('ip')))));
  sendAll(ownAddresses, ownTopic, perConnection, 'own');
  expect(await settledCount(own)).toBe(total);

  for (const client of [shared, own, ...sameAddress, ...ownAddresses]) client.socket.close();
});

test('a banned address is turned away, and other addresses are not', async () => {
  const topic = canary('topic');
  const ip = canary('ip');
  const banned = await connect(limitedFrom(ip));
  publish(banned, topic, RATE_LIMIT.connection.burst + RATE_LIMIT.banAfter, 'ban me');
  expect(await banned.closed).toBe(1008);

  const again = await connect(limitedFrom(ip));
  expect(await again.closed).toBe(1008);

  const other = await connect(limitedFrom(canary('ip')));
  publish(other, topic, 1, 'welcome');
  await expect.poll(() => okReplies(other).map((m) => m[2])).toEqual([true]);
  other.socket.close();
});
