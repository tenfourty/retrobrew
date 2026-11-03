import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES } from './relay-frame';
import type { Inbound, SendOptions } from './types';
import { fromUtf8, utf8 } from '../crypto/bytes';
import { waitFor } from '../test/wait';
import { HybridTransport } from './hybrid';
import { MemoryNetwork } from './memory';

function pair() {
  const direct = new MemoryNetwork('direct');
  const relay = new MemoryNetwork('relayed');
  return { direct, relay };
}

describe('HybridTransport', () => {
  it('uses the relay until a direct connection exists', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'));
    const b = relay.join('b'); // b has no direct path at all
    const got: string[] = [];
    b.onMessage((from, data) => got.push(`${from}:${fromUtf8(data)}`));
    await waitFor(() => a.status('b') === 'relayed');
    a.send('b', utf8('via relay'));
    await waitFor(() => got.length === 1);
    expect(got).toEqual(['a:via relay']);
  });

  it('prefers direct when both paths are up and reports it', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'));
    const b = new HybridTransport(direct.join('b'), relay.join('b'));
    const frames: string[] = [];
    direct.tap = () => frames.push('direct');
    relay.tap = () => frames.push('relay');
    await waitFor(() => a.status('b') === 'direct');
    a.send('b', utf8('x'));
    expect(frames).toEqual(['direct']);
    expect(b.peers()).toEqual(['a']);
  });

  it('announces a peer once and only reports leaving when both paths are gone', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'));
    const joins: string[] = [];
    const leaves: string[] = [];
    a.onPeerJoin((p) => joins.push(p));
    a.onPeerLeave((p) => leaves.push(p));
    direct.join('b');
    relay.join('b');
    await waitFor(() => a.status('b') === 'direct');
    expect(joins).toEqual(['b']);
    direct.drop('b');
    expect(a.status('b')).toBe('relayed');
    expect(leaves).toEqual([]);
    relay.drop('b');
    expect(leaves).toEqual(['b']);
  });

  it('can be forced onto the relay for testing', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'), { forceRelay: true });
    new HybridTransport(direct.join('b'), relay.join('b'));
    const frames: string[] = [];
    direct.tap = () => frames.push('direct');
    relay.tap = () => frames.push('relay');
    await waitFor(() => a.status('b') === 'relayed');
    a.send('b', utf8('x'));
    expect(frames).toEqual(['relay']);
  });

  it('reports the peers of the direct path alone', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'));
    relay.join('b');
    new HybridTransport(direct.join('c'), relay.join('c'));
    await waitFor(() => a.peers().length === 2);
    expect(a.directPeers()).toEqual(['c']);
  });

  it('refuses transports with different self IDs', () => {
    const { direct, relay } = pair();
    expect(() => new HybridTransport(direct.join('a'), relay.join('z'))).toThrow();
  });
});

describe('HybridTransport paths', () => {
  it('falls back to the relay when a direct send is rejected, until the peer sends directly again', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'));
    const bDirect = direct.join('b');
    relay.join('b');
    await waitFor(() => a.status('b') === 'direct');
    direct.failSends = true;
    expect(await a.sendVia('b', utf8('x'), 'direct')).toBe('relay');
    expect(a.status('b')).toBe('relayed');
    direct.failSends = false;
    expect(await a.sendVia('b', utf8('y'), 'direct')).toBe('relay');
    bDirect.send('a', utf8('back'));
    await waitFor(() => a.status('b') === 'direct');
    expect(await a.sendVia('b', utf8('z'), 'direct')).toBe('direct');
    direct.failSends = true;
    expect(await a.sendVia('b', utf8('no fallback'), 'direct', { fallback: false })).toBeNull();
    expect(await a.sendVia('b', utf8('none at all'), 'direct', { fallback: false })).toBeNull();
  });

  it('reports the path each message arrived on, and hands relay echoes only to onInbound', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'));
    const b = new HybridTransport(direct.join('b'), relay.join('b'));
    const inbound: Inbound[] = [];
    const messages: string[] = [];
    a.onInbound((m) => inbound.push(m));
    a.onMessage((from) => messages.push(from));
    await waitFor(() => a.status('b') === 'direct' && b.status('a') === 'direct');
    await b.sendVia('a', utf8('d'), 'direct');
    await b.sendVia('a', utf8('r'), 'relay');
    await a.sendVia('b', utf8('ping'), 'relay', { echo: true });
    await waitFor(() => inbound.length === 3);
    expect(inbound.map((m) => [m.from, m.path, m.echo])).toEqual([['b', 'direct', false], ['b', 'relay', false], ['a', 'relay', true]]);
    expect(messages).toEqual(['b', 'b']);
  });

  it('passes a relay send’s kind, what it supersedes, whether it is lasting and whether it is expendable to the relay transport, never fallback', async () => {
    const { direct, relay } = pair();
    const relayA = relay.join('a');
    const seen: SendOptions[] = [];
    const send = relayA.send.bind(relayA);
    relayA.send = (peerId, data, opts) => { seen.push(opts ?? {}); return send(peerId, data, opts); };
    const a = new HybridTransport(direct.join('a'), relayA);
    relay.join('b');
    const opts = { kind: 'cmd 1', supersedes: ['cmd 1'], lasting: true, expendable: () => true };
    await a.sendVia('b', utf8('x'), 'relay', opts);
    await a.sendVia('b', utf8('y'), 'direct', { ...opts, fallback: true }); // no direct path: falls back to the relay
    expect(seen).toEqual([{ echo: undefined, ...opts }, { echo: undefined, ...opts }]);
  });

  it('broadcasts on the relay only, and resumes both paths', async () => {
    const { direct, relay } = pair();
    const relayA = relay.join('a');
    const a = new HybridTransport(direct.join('a'), relayA);
    new HybridTransport(direct.join('b'), relay.join('b'));
    const frames: string[] = [];
    direct.tap = () => frames.push('direct');
    relay.tap = () => frames.push('relay');
    await waitFor(() => a.status('b') === 'direct');
    a.broadcastRelay(utf8('bundle'));
    expect(frames).toEqual(['relay']);
    a.resume();
    expect(relayA.resumed).toBe(1);
  });

  it('passes the resume focus to the direct path, which alone uses it', () => {
    const { direct, relay } = pair();
    const directA = direct.join('a');
    const relayA = relay.join('a');
    const a = new HybridTransport(directA, relayA);
    a.resume({ host: 'b' });
    a.resume();
    expect(directA.resumeFocus).toEqual([{ host: 'b' }, undefined]);
    expect(relayA.resumeFocus).toEqual([undefined, undefined]);
  });

  it('clears the direct-down mark when the peer joins directly again, and lets a probe ignore it', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'));
    direct.join('b');
    relay.join('b');
    await waitFor(() => a.status('b') === 'direct');
    direct.failSends = true;
    await a.sendVia('b', utf8('x'), 'direct');
    expect(a.status('b')).toBe('relayed');
    direct.failSends = false;
    const sent: string[] = [];
    direct.tap = (_f, _t, d) => sent.push(fromUtf8(d));
    expect(await a.sendVia('b', utf8('probe'), 'direct', { fallback: false })).toBe('direct');
    expect(sent).toEqual(['probe']);
    expect(a.status('b')).toBe('direct'); // proven by the probe alone: no inbound message, join or leave
    direct.failSends = true;
    await a.sendVia('b', utf8('y'), 'direct');
    expect(a.status('b')).toBe('relayed');
    direct.failSends = false;
    direct.drop('b');
    direct.join('b');
    await waitFor(() => a.status('b') === 'direct');
    sent.length = 0;
    expect(await a.sendVia('b', utf8('after rejoin'), 'direct')).toBe('direct');
    expect(sent).toEqual(['after rejoin']);
  });

  it('clears the direct-down mark when the peer leaves directly', async () => {
    const { direct, relay } = pair();
    const directA = direct.join('a');
    const a = new HybridTransport(directA, relay.join('a'));
    direct.join('b');
    relay.join('b');
    await waitFor(() => a.status('b') === 'direct');
    direct.failSends = true;
    await a.sendVia('b', utf8('x'), 'direct');
    const marks = (a as unknown as { directDown: Set<string> }).directDown;
    expect(marks.has('b')).toBe(true);
    directA.peerLeft('b');
    expect(marks.has('b')).toBe(false);
  });
});

describe('the frame cap on both paths', () => {
  it('drops a message over MAX_FRAME_BYTES on either path before anyone sees it', async () => {
    const { direct, relay } = pair();
    const a = new HybridTransport(direct.join('a'), relay.join('a'));
    const b = new HybridTransport(direct.join('b'), relay.join('b'));
    const got: number[] = [];
    b.onInbound((m) => got.push(m.data.length));
    await waitFor(() => a.status('b') === 'direct');
    await a.sendVia('b', new Uint8Array(MAX_FRAME_BYTES + 1), 'direct');
    await a.sendVia('b', new Uint8Array(MAX_FRAME_BYTES + 1), 'relay');
    await a.sendVia('b', new Uint8Array(10), 'relay');
    await waitFor(() => got.length === 1);
    expect(got).toEqual([10]);
  });
});
