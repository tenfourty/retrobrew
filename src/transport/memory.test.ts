import { describe, expect, it } from 'vitest';
import { fromUtf8, utf8 } from '../crypto/bytes';
import { sleep, waitFor } from '../test/wait';
import { FakeScheduler } from '../test/fake-scheduler';
import { MemoryNetwork } from './memory';

describe('MemoryNetwork', () => {
  it('announces peers to each other and delivers messages', async () => {
    const net = new MemoryNetwork();
    const a = net.join('a');
    const b = net.join('b');
    const joined: string[] = [];
    const received: string[] = [];
    a.onPeerJoin((p) => joined.push(p));
    b.onMessage((from, data) => received.push(`${from}:${fromUtf8(data)}`));
    await waitFor(() => joined.includes('b'));
    a.send('b', utf8('hi'));
    await waitFor(() => received.length === 1);
    expect(received).toEqual(['a:hi']);
    expect(a.status('b')).toBe('direct');
  });

  it('broadcasts to every peer', async () => {
    const net = new MemoryNetwork();
    const a = net.join('a');
    const got: string[] = [];
    for (const id of ['b', 'c']) net.join(id).onMessage(() => got.push(id));
    await waitFor(() => a.peers().length === 2);
    a.broadcast(utf8('x'));
    await waitFor(() => got.length === 2);
    expect(got.sort()).toEqual(['b', 'c']);
  });

  it('reports leaving and stops delivery', async () => {
    const net = new MemoryNetwork('relayed');
    const a = net.join('a');
    const b = net.join('b');
    const left: string[] = [];
    let received = 0;
    a.onPeerLeave((p) => left.push(p));
    b.onMessage(() => received++);
    await waitFor(() => a.peers().includes('b'));
    expect(a.status('b')).toBe('relayed');
    b.leave();
    expect(left).toEqual(['b']);
    expect(a.status('b')).toBe('offline');
    a.send('b', utf8('late'));
    await sleep(20);
    expect(received).toBe(0);
  });

  it('lets tests tap delivered frames', async () => {
    const net = new MemoryNetwork();
    const frames: string[] = [];
    net.tap = (from, to) => frames.push(`${from}->${to}`);
    const a = net.join('a');
    net.join('b');
    await waitFor(() => a.peers().includes('b'));
    a.send('b', utf8('x'));
    expect(frames).toEqual(['a->b']);
  });
});

describe('MemoryNetwork test hooks', () => {
  it('delays delivery on a scheduler when asked', async () => {
    const scheduler = new FakeScheduler(0);
    const net = new MemoryNetwork('relayed');
    net.scheduler = scheduler;
    net.delay = () => 300;
    const a = net.join('a');
    const got: string[] = [];
    net.join('b').onMessage((_from, data) => got.push(fromUtf8(data)));
    await waitFor(() => a.peers().includes('b'));
    a.send('b', utf8('late'));
    scheduler.advance(299);
    expect(got).toEqual([]);
    scheduler.advance(1);
    expect(got).toEqual(['late']);
  });

  it('echoes a send back to the sender when asked', async () => {
    const net = new MemoryNetwork('relayed');
    const a = net.join('a');
    net.join('b');
    const echoes: boolean[] = [];
    a.onMessage((from, _data, meta) => { if (from === 'a') echoes.push(meta?.echo === true); });
    await waitFor(() => a.peers().includes('b'));
    await a.send('b', utf8('ping'), { echo: true });
    await waitFor(() => echoes.length === 1);
    expect(echoes).toEqual([true]);
  });

  it('loses the deliveries a test asks it to', async () => {
    const net = new MemoryNetwork();
    const a = net.join('a');
    const got: string[] = [];
    net.join('b').onMessage((_from, data) => got.push(fromUtf8(data)));
    await waitFor(() => a.peers().includes('b'));
    net.lose = (_from, _to, data) => fromUtf8(data) === 'lost';
    a.send('b', utf8('lost'));
    a.send('b', utf8('kept'));
    await waitFor(() => got.length === 1);
    expect(got).toEqual(['kept']);
  });

  it('rejects sends while failSends is set', async () => {
    const net = new MemoryNetwork();
    const a = net.join('a');
    net.join('b');
    await waitFor(() => a.peers().includes('b'));
    net.failSends = true;
    await expect(a.send('b', utf8('x'))).rejects.toThrow('send failed');
  });
});
