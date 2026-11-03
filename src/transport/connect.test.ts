import { describe, expect, it, vi } from 'vitest';
import { fromUtf8, utf8 } from '../crypto/bytes';
import type { ShareLink } from '../link';
import { waitFor } from '../test/wait';
import { createRoomTransport } from './connect';
import { MemoryNetwork } from './memory';

const link: ShareLink = { boardId: 'board-0001', roomKey: new Uint8Array(32).fill(7), hostPub: 'host-pub' };

describe('createRoomTransport', () => {
  it('uses the relay alone when the direct transport cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const relay = new MemoryNetwork('relayed');
    const a = await createRoomTransport(link, [], {}, {
      direct: () => { throw new TypeError('RTCPeerConnection is not defined'); },
      relay: (o) => relay.join(o.selfId),
    });
    const b = relay.join('b');
    const atA: string[] = [];
    const atB: string[] = [];
    a.onMessage((from, data) => atA.push(`${from}:${fromUtf8(data)}`));
    b.onMessage((from, data) => atB.push(`${from}:${fromUtf8(data)}`));

    await waitFor(() => a.status('b') === 'relayed');
    a.send('b', utf8('hello'));
    b.send(a.selfId, utf8('welcome'));
    await waitFor(() => atA.length === 1 && atB.length === 1);
    expect(atB).toEqual([`${a.selfId}:hello`]);
    expect(atA).toEqual(['b:welcome']);
    expect(a.peers()).toEqual(['b']);
    expect(warn).toHaveBeenCalled();
    a.leave();
    warn.mockRestore();
  });

  it('uses the relay alone in a browser without WebRTC', async () => {
    expect(typeof globalThis.RTCPeerConnection).toBe('undefined');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const relay = new MemoryNetwork('relayed');
    const a = await createRoomTransport(link, [], {}, { relay: (o) => relay.join(o.selfId) });
    relay.join('b');
    await waitFor(() => a.status('b') === 'relayed');
    expect(a.selfId).toMatch(/\S/);
    a.leave();
    warn.mockRestore();
  });

  it('prefers the direct transport when it can be created', async () => {
    const direct = new MemoryNetwork('direct');
    const relay = new MemoryNetwork('relayed');
    const a = await createRoomTransport(link, [], {}, {
      direct: () => direct.join('a'),
      relay: (o) => relay.join(o.selfId),
    });
    direct.join('b');
    relay.join('b');
    await waitFor(() => a.status('b') === 'direct');
    expect(a.selfId).toBe('a');
  });
});
