import { expect, test } from '@playwright/test';
import { WebSocket, WebSocketServer } from 'ws';
import { startRateLimitProxy } from './relay/rate-limit-proxy';

test('after a ban closes the connection, later messages in the same burst are not forwarded', async () => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 17791 });
  const forwarded: string[] = [];
  upstream.on('connection', (socket) => socket.on('message', (data) => forwarded.push(data.toString())));
  const proxy = await startRateLimitProxy({
    port: 17792,
    upstream: 'ws://127.0.0.1:17791',
    limit: {
      connection: { eventsPerSecond: 0.001, burst: 1 },
      address: { eventsPerSecond: 0.001, burst: 100 },
      banAfter: 1,
      banSeconds: 1,
    },
  });
  try {
    const client = new WebSocket('ws://127.0.0.1:17792');
    const closed = new Promise<number>((resolve) => client.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    // The second event is refused and bans the address; the REQ sent after it, in the same burst, must go nowhere.
    client.send(JSON.stringify(['EVENT', { id: 'one' }]));
    client.send(JSON.stringify(['EVENT', { id: 'two' }]));
    client.send(JSON.stringify(['REQ', 'late', {}]));
    expect(await closed).toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(forwarded.filter((m) => m.includes('late'))).toEqual([]);
    expect(forwarded.some((m) => m.includes('"one"'))).toBe(true);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
