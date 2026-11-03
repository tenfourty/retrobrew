import { describe, expect, it } from 'vitest';
import { parseVersionReply, parseToHost, parseToPeer } from './messages';
import { newSid } from './sid';

const sid = newSid(1_760_000_000_000);

describe('parseToHost', () => {
  it('reads a hello in either layout; a hello without pv is protocol 1', () => {
    expect(parseToHost({ t: 'hello', name: 'Ann', peer: 'p1' }, 1)).toEqual({ t: 'hello', pv: 1, boardId: null, name: 'Ann', peer: 'p1' });
    expect(parseToHost({ t: 'hello', pv: 3, boardId: 'b1', name: 'Ann', peer: 'p1' }, 1))
      .toEqual({ t: 'hello', pv: 3, boardId: 'b1', name: 'Ann', peer: 'p1' });
  });

  it('reads commands and pings only in protocol 2, and only when well formed', () => {
    const cmd = { t: 'cmd', boardId: 'b1', peer: 'p1', clientSeq: 1, sid, epoch: 5, cmd: { type: 'anything' } };
    expect(parseToHost(cmd, 2)).toEqual(cmd);
    expect(parseToHost(cmd, 1)).toBeNull();
    for (const bad of [{ clientSeq: 0 }, { clientSeq: 1.5 }, { sid: 'tab-a' }, { boardId: undefined }, { peer: undefined }, { epoch: 'x' }]) {
      expect(parseToHost({ ...cmd, ...bad }, 2)).toBeNull();
    }
    const ping = { t: 'ping', boardId: 'b1', sid, n: 1, at: 7, t0: 5, peer: 'p1' };
    expect(parseToHost(ping, 2)).toEqual(ping);
    expect(parseToHost(ping, 1)).toBeNull();
    expect(parseToHost({ ...ping, boardId: undefined }, 2)).toBeNull();
    expect(parseToHost({ ...ping, peer: undefined }, 2)).toBeNull();
    expect(parseToHost({ ...ping, sid: 'not-a-sid' }, 2)).toBeNull();
    expect(parseToHost({ ...ping, n: 0 }, 2)).toBeNull();
    expect(parseToHost({ ...ping, n: 1.5 }, 2)).toBeNull();
    expect(parseToHost({ ...ping, at: 'now' }, 2)).toBeNull();
    expect(parseToHost({ ...ping, t0: undefined }, 2)).toBeNull();
  });

  // Kept from the merged sid and clientSeq fixes: a cmd needs a valid sid and a safe integer clientSeq of at least 1.
  const valid = { t: 'cmd', boardId: 'b1', peer: 'p1', clientSeq: 1, sid, epoch: 1, cmd: { type: 'setShowVotes', value: false } };

  it('refuses a malformed or several-KB sid', () => {
    for (const bad of ['', 'abc', 'x'.repeat(4096), `${sid}${'a'.repeat(4096)}`]) {
      expect(parseToHost({ ...valid, sid: bad }, 2)).toBeNull();
    }
  });

  it('refuses a clientSeq that is not a safe integer of at least 1', () => {
    for (const bad of [1e308, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(parseToHost({ ...valid, clientSeq: bad }, 2)).toBeNull();
    }
  });
});

describe('parseToPeer', () => {
  it('reads a snapshot naming hostNow and its meeting, filling in missing view fields', () => {
    const msg = parseToPeer({ t: 'snapshot', epoch: 1, seq: 2, hostNow: 3, you: 'me', host: 'h', state: { boardId: 'b1', boardName: 'Team' } });
    expect(msg).toMatchObject({ t: 'snapshot', hostNow: 3, state: { boardId: 'b1', boardName: 'Team', phase: 'topics', timer: null, vote: null, rehearsal: false, acks: {}, rejects: {} } });
    expect(parseToPeer({ t: 'snapshot', epoch: 1, seq: 2, you: 'me', host: 'h', state: { boardId: 'b1' } })).toBeNull();
    expect(parseToPeer({ t: 'snapshot', epoch: 1, seq: 2, hostNow: 3, you: 'me', host: 'h', state: { topics: [] } })).toBeNull();
  });

  it('refuses a view whose fields have the wrong types, rather than letting it throw later', () => {
    const snap = (state: Record<string, unknown>) => parseToPeer({ t: 'snapshot', epoch: 1, seq: 2, hostNow: 3, you: 'me', host: 'h', state: { boardId: 'b1', ...state } });
    for (const bad of [
      { acks: null }, { acks: [] }, { rejects: 'x' }, { topics: {} }, { attendees: [] }, { online: 'Ann' },
      { discussedOrder: null }, { voteAllowance: Number.NaN }, { voteAllowance: '3' }, { endedAt: 'soon' },
      { timer: 5 }, { vote: [] }, { showVotes: 'yes' }, { boardName: 7 }, { phase: null }, { joinRefused: 3 },
    ]) {
      expect(snap(bad)).toBeNull();
    }
    expect(snap({ endedAt: 5, timer: { endsAt: 9 }, vote: null, joinRefused: 'meetingFull' })).not.toBeNull();
  });

  it('reads a pong, and nothing else', () => {
    expect(parseToPeer({ t: 'pong', t0: 1, t1: 2 })).toEqual({ t: 'pong', t0: 1, t1: 2 });
    expect(parseToPeer({ t: 'reject', clientSeq: 1, message: 'x' })).toBeNull();
  });
});

describe('parseVersionReply', () => {
  it('reads a version reply down to its board name', () => {
    expect(parseVersionReply({ t: 'snapshot', epoch: 9, seq: 0, you: 'me', host: 'h', state: { boardName: 'Old', topics: [] } }))
      .toEqual({ t: 'snapshot', epoch: 9, seq: 0, you: 'me', host: 'h', boardName: 'Old' });
    expect(parseVersionReply({ t: 'snapshot', epoch: 9, seq: 0, you: 'me', host: 'h', state: {} })).toBeNull();
  });
});
