import { connect, createServer } from 'node:net';
import { expect, test } from '@playwright/test';
import { externalRelayUpstream } from './relay/global-setup';
import { startTcpForward } from './relay/tcp-forward';

test('the forward carries bytes both ways, and close() resolves with a connection open', async () => {
  const upstream = createServer((socket) => socket.on('data', (data) => socket.write(`echo:${data.toString()}`)));
  await new Promise<void>((resolve) => upstream.listen({ host: '127.0.0.1', port: 17793 }, () => resolve()));
  const forward = await startTcpForward({ port: 17794, upstream: { host: '127.0.0.1', port: 17793 } });
  try {
    const client = connect({ host: '127.0.0.1', port: 17794 });
    const reply = new Promise<string>((resolve) => client.once('data', (data) => resolve(data.toString())));
    client.write('hello');
    expect(await reply).toBe('echo:hello');
    await forward.close();
    client.destroy();
  } finally {
    await forward.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('E2E_RELAY_UPSTREAM is host:port, or absent', () => {
  expect(externalRelayUpstream('dind:17777')).toEqual({ host: 'dind', port: 17777 });
  expect(externalRelayUpstream('')).toBeUndefined();
  expect(() => externalRelayUpstream('dind')).toThrow(/host:port/);
  expect(() => externalRelayUpstream('dind:port')).toThrow(/host:port/);
});
