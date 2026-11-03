import { describe, expect, it } from 'vitest';
import { newSid } from '../protocol/sid';
import { GoneFilter } from './gone-filter';
import {
  classify, CLOCK_SKEW_MS, deliveryFor, MAX_TABLE_ENTRIES, MAX_TABS_PER_PERSON, parseTabTable, prune, PRUNE_AFTER_MS, recordOutcome, type TabTable,
} from './tabs';

// What the work was, not how long it took: every Array sort made while fn runs, with its length and the number of
// times its comparator was called. This is coupled to Array.prototype.sort: a rewrite that sorts another way (a heap,
// a selection of the newest few) should keep the property, one pass and no sort per eviction, and update these counts.
// A wall-clock bound fails on a loaded machine; a count of operations does not.
function countingSorts<T>(fn: () => T): { result: T; sorts: Array<{ length: number; comparisons: number }> } {
  const original = Array.prototype.sort;
  const sorts: Array<{ length: number; comparisons: number }> = [];
  Array.prototype.sort = function counted(this: unknown[], compare?: (a: unknown, b: unknown) => number) {
    const record = { length: this.length, comparisons: 0 };
    sorts.push(record);
    if (!compare) return original.call(this);
    return original.call(this, (a: unknown, b: unknown) => { record.comparisons += 1; return compare(a, b); });
  } as typeof Array.prototype.sort;
  try {
    return { result: fn(), sorts };
  } finally {
    Array.prototype.sort = original;
  }
}

const T0 = 1_760_000_000_000;
const tabA = newSid(T0);
const tabB = newSid(T0 + 1);

function after(...outcomes: Array<[string, number, string?]>): TabTable {
  let table: TabTable = {};
  outcomes.forEach(([sid, clientSeq, reject], i) => { table = recordOutcome(table, 'ann', sid, clientSeq, T0 + i, reject); });
  return table;
}

describe('classify', () => {
  it('starts a new tab at 1 and applies strictly in order', () => {
    expect(classify({}, 'ann', tabA, 1)).toBe('apply');
    expect(classify({}, 'ann', tabA, 2)).toBe('buffer');
    const table = after([tabA, 1], [tabA, 2]);
    expect(classify(table, 'ann', tabA, 3)).toBe('apply');
    expect(classify(table, 'ann', tabA, 2)).toBe('duplicate');
    expect(classify(table, 'ann', tabA, 1)).toBe('duplicate');
  });

  it('buffers within the 64-command window and drops beyond it', () => {
    const table = after([tabA, 1]);
    expect(classify(table, 'ann', tabA, 65)).toBe('buffer');
    expect(classify(table, 'ann', tabA, 66)).toBe('drop');
  });

  it('keeps each tab and each person apart', () => {
    const table = after([tabA, 1], [tabA, 2]);
    expect(classify(table, 'ann', tabB, 1)).toBe('apply');
    expect(classify(table, 'bob', tabA, 1)).toBe('apply');
  });
});

describe('rejects', () => {
  it('count as applied, and only the last one per tab is kept until its next command', () => {
    let table = after([tabA, 1, 'noVotesLeft']);
    expect(table.ann.tabs[tabA]).toEqual({ ack: 1, lastCommandAt: T0, reject: { clientSeq: 1, key: 'noVotesLeft' } });
    expect(classify(table, 'ann', tabA, 2)).toBe('apply');
    table = recordOutcome(table, 'ann', tabA, 2, T0 + 5);
    expect(table.ann.tabs[tabA].reject).toBeUndefined();
  });
});

describe('deliveryFor', () => {
  it('lists acks and pending rejects for the three most recently active tabs of that person', () => {
    const tabs = [0, 1, 2, 3].map((i) => newSid(T0 + i));
    let table: TabTable = {};
    tabs.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i * 1000, i === 3 ? 'noVotesLeft' : undefined); });
    const delivery = deliveryFor(table, 'ann');
    expect(Object.keys(delivery.acks).sort()).toEqual([tabs[1], tabs[2], tabs[3]].sort());
    expect(delivery.rejects).toEqual({ [tabs[3]]: { clientSeq: 1, key: 'noVotesLeft' } });
    expect(deliveryFor(table, 'bob')).toEqual({ acks: {}, rejects: {} });
  });

  it('lists a tab again as soon as it resends, because that makes it the most recent', () => {
    const tabs = [0, 1, 2, 3].map((i) => newSid(T0 + i));
    let table: TabTable = {};
    tabs.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i * 1000); });
    expect(deliveryFor(table, 'ann').acks[tabs[0]]).toBeUndefined();
    // A resend lists it without counting as activity: lastCommandAt stays, so a replay can't keep a tab alive.
    expect(deliveryFor(table, 'ann', undefined, { [tabs[0]]: T0 + 10_000 }).acks[tabs[0]]).toBe(1);
    expect(table.ann.tabs[tabs[0]].lastCommandAt).toBe(T0);
  });

  it('always gives the tab with the newest command a slot, however many older tabs are listed', () => {
    const tabs = [0, 1, 2, 3, 4].map((i) => newSid(T0 + i));
    let table: TabTable = {};
    tabs.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i * 1000); });
    const live = tabs[4];
    // Copies of commands from three older tabs, listed after the live tab's last command.
    const listed = { [tabs[0]]: T0 + 20_000, [tabs[1]]: T0 + 20_001, [tabs[2]]: T0 + 20_002 };
    const delivery = deliveryFor(table, 'ann', undefined, listed);
    expect(delivery.acks[live]).toBe(1);
    expect(Object.keys(delivery.acks)).toHaveLength(3);
  });

  it('ranks a tab by the host’s in-memory listing note as well as its last command, leaving the table alone', () => {
    const tabs = [0, 1, 2, 3].map((i) => newSid(T0 + i));
    let table: TabTable = {};
    tabs.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i * 1000); });
    const before = JSON.stringify(table);
    expect(deliveryFor(table, 'ann').acks[tabs[0]]).toBeUndefined();
    expect(deliveryFor(table, 'ann', undefined, { [tabs[0]]: T0 + 10_000 }).acks[tabs[0]]).toBe(1);
    expect(JSON.stringify(table)).toBe(before);
  });

  it('carries a staleTab reject for a refused stale tab, still within three entries', () => {
    const tabs = [0, 1, 2].map((i) => newSid(T0 + i));
    let table: TabTable = {};
    tabs.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i * 1000); });
    const stale = { sid: newSid(T0 - 5), clientSeq: 4, at: T0 + 9000, key: 'staleTab' as const };
    const delivery = deliveryFor(table, 'ann', stale);
    expect(delivery.rejects[stale.sid]).toEqual({ clientSeq: 4, key: 'staleTab' });
    expect(delivery.acks[stale.sid]).toBeUndefined();
    expect(Object.keys(delivery.acks).length + (delivery.rejects[stale.sid] ? 1 : 0)).toBeLessThanOrEqual(3);
  });
});

describe('pruning', () => {
  it('prunes tabs idle for more than 24 hours and raises the watermark', () => {
    const old = newSid(T0);
    const recent = newSid(T0 + 10);
    let table = recordOutcome({}, 'ann', old, 3, T0);
    table = recordOutcome(table, 'ann', recent, 1, T0 + PRUNE_AFTER_MS);
    expect(prune(table, T0 + PRUNE_AFTER_MS)).toBe(table);
    const pruned = prune(table, T0 + PRUNE_AFTER_MS + 1);
    expect(Object.keys(pruned.ann.tabs)).toEqual([recent]);
    expect(pruned.ann.watermark).toBe(T0);
  });

  it('refuses an unknown tab created at or before the watermark, and accepts a later one from 1', () => {
    const table = prune(recordOutcome({}, 'ann', newSid(T0), 3, T0), T0 + PRUNE_AFTER_MS + 1);
    expect(classify(table, 'ann', newSid(T0), 4)).toBe('stale');
    expect(classify(table, 'ann', newSid(T0 - 1), 1)).toBe('stale');
    expect(classify(table, 'ann', newSid(T0 + 1), 1)).toBe('apply');
  });

  it('lets a person who reloads after a prune carry on from a fresh tab', () => {
    const table = prune(recordOutcome({}, 'ann', newSid(T0), 3, T0), T0 + PRUNE_AFTER_MS + 1);
    const reloaded = newSid(T0 + PRUNE_AFTER_MS + 2);
    expect(classify(table, 'ann', reloaded, 1)).toBe('apply');
  });
});

describe('bounds', () => {
  const sids = (n: number, from = T0) => Array.from({ length: n }, (_, i) => newSid(from + i * 1000));

  it('drops a person’s least recently active tab when a sixth arrives, raising the watermark to it', () => {
    const tabs = sids(6);
    let table: TabTable = {};
    tabs.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i * 1000); });
    expect(Object.keys(table.ann.tabs).sort()).toEqual(tabs.slice(1).sort());
    expect(table.ann.tabs[tabs[0]]).toBeUndefined();
    expect(table.ann.watermark).toBe(T0 - CLOCK_SKEW_MS);
    expect(table.ann.evicted).toEqual([tabs[0]]);
    expect(Object.getPrototypeOf(table.ann.tabs)).toBeNull();
  });

  it('ranks by activity, not by age: a resend never saves a tab, a new command does', () => {
    const tabs = sids(6);
    let table: TabTable = {};
    tabs.slice(0, 5).forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i * 1000); });
    table = recordOutcome(table, 'ann', tabs[0], 2, T0 + 9000); // the oldest tab sends again
    table = recordOutcome(table, 'ann', tabs[5], 1, T0 + 10_000);
    expect(table.ann.tabs[tabs[0]]).toBeDefined();
    expect(table.ann.evicted).toEqual([tabs[1]]);
  });

  it('refuses the dropped tab with tooManyTabs, and any unknown tab no newer than it, so nothing is replayed', () => {
    const tabs = sids(6);
    let table: TabTable = {};
    tabs.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, i + 1, T0 + i * 1000); });
    expect(classify(table, 'ann', tabs[0], 1)).toBe('evicted');
    expect(classify(table, 'ann', tabs[0], 2)).toBe('evicted');
    expect(classify(table, 'ann', newSid(T0 - CLOCK_SKEW_MS - 1), 1)).toBe('stale');
    expect(classify(table, 'ann', newSid(T0 + 10_000), 1)).toBe('apply');
  });

  it('lets a device whose clock runs 5 minutes slow reload after a drop, without staleTab', () => {
    const tabs = sids(6);
    let table: TabTable = {};
    tabs.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i * 1000); });
    // The reload happens just after the drop, on a clock 5 minutes behind the host's.
    expect(classify(table, 'ann', newSid(T0 + 6000 - 5 * 60_000), 1)).toBe('apply');
  });

  it('refuses, through the host’s filter, a dropped sid it no longer lists, even with a fast clock', () => {
    const future = sids(17, T0 + 3_600_000);
    const gone = new GoneFilter();
    let table: TabTable = {};
    future.forEach((sid, i) => {
      const before = table;
      table = recordOutcome(table, 'ann', sid, 1, T0 + i);
      for (const old of Object.keys(before.ann?.tabs ?? {})) if (!table.ann.tabs[old]) gone.add('ann', old);
    });
    expect(table.ann.evicted).not.toContain(future[0]);
    expect(classify(table, 'ann', future[0], 1)).toBe('apply'); // no filter: the old command would apply again
    expect(classify(table, 'ann', future[0], 1, (sid) => gone.has('ann', sid))).toBe('stale');
    expect(classify({}, 'ann', future[0], 1, (sid) => gone.has('ann', sid))).toBe('stale'); // no entry at all
    expect(classify(table, 'ann', newSid(T0 + 3_700_000), 1, (sid) => gone.has('ann', sid))).toBe('apply');
  });

  it('carries a tooManyTabs reject for a dropped tab that sends again', () => {
    const sid = newSid(T0);
    const delivery = deliveryFor({}, 'ann', { sid, clientSeq: 2, at: T0, key: 'tooManyTabs' });
    expect(delivery.rejects[sid]).toEqual({ clientSeq: 2, key: 'tooManyTabs' });
  });

  it('never moves the watermark past the host’s clock, so a device whose clock runs ahead can open new tabs', () => {
    const future = sids(6, T0 + 3_600_000);
    let table: TabTable = {};
    future.forEach((sid, i) => { table = recordOutcome(table, 'ann', sid, 1, T0 + i); });
    expect(table.ann.watermark).toBe(T0 + 5);
    expect(classify(table, 'ann', newSid(T0 + 3_700_000), 1)).toBe('apply');
    expect(classify(table, 'ann', future[0], 1)).toBe('evicted');
    // Pruning clamps the same way.
    const farAhead = newSid(T0 + 3 * PRUNE_AFTER_MS);
    const pruned = prune(recordOutcome({}, 'bob', farAhead, 1, T0), T0 + PRUNE_AFTER_MS + 10);
    expect(pruned.bob.watermark).toBe(T0 + PRUNE_AFTER_MS + 10);
  });

  it('keeps any flood of sids within the per-person and board-wide bounds', () => {
    let table: TabTable = {};
    let now = T0;
    let seed = 7;
    const random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
    let full = 0;
    for (let i = 0; i < 700; i++) {
      now += Math.floor(random() * 1000);
      const person = `p${Math.floor(random() * 120)}`;
      const sid = newSid(now - Math.floor(random() * 1e7));
      const others = Object.entries(table).filter(([id]) => id !== person).flatMap(([id, p]) => Object.keys(p.tabs).map((s) => [id, s]));
      const arrival = classify(table, person, sid, 1);
      if (arrival === 'full') full += 1;
      if (arrival === 'apply') table = recordOutcome(table, person, sid, 1, now);
      else if (arrival === 'full' && recordOutcome(table, person, sid, 1, now) !== table) throw new Error('admitted past the bound');
      // Nobody else's tab ever makes way: only the sender's own tabs can go.
      if (!others.every(([id, s]) => Object.hasOwn(table[id].tabs, s))) throw new Error('another person’s tab was dropped');
      if (Object.values(table).some((p) => Object.keys(p.tabs).length > MAX_TABS_PER_PERSON)) throw new Error('over five tabs');
      const entries = Object.values(table).reduce((n, p) => n + Math.max(1, Object.keys(p.tabs).length), 0);
      if (entries > MAX_TABLE_ENTRIES) throw new Error(`over the bound: ${entries}`);
    }
    const entries = Object.values(table).reduce((n, p) => n + Math.max(1, Object.keys(p.tabs).length), 0);
    expect(entries).toBeGreaterThan(MAX_TABLE_ENTRIES - MAX_TABS_PER_PERSON);
    expect(full).toBeGreaterThan(0);
    expect(Object.getPrototypeOf(table)).toBeNull();
  });

  it('counts a person with no tabs left as one entry, attendee or not, and refuses a new tab when full', () => {
    let table: TabTable = {};
    // 300 people with one tab each, all pruned: 300 empty entries.
    for (let i = 0; i < MAX_TABLE_ENTRIES; i++) table = recordOutcome(table, `gone${i}`, newSid(T0 + i), 1, T0 + i);
    table = prune(table, T0 + PRUNE_AFTER_MS + MAX_TABLE_ENTRIES);
    expect(Object.keys(table)).toHaveLength(MAX_TABLE_ENTRIES);
    const later = T0 + PRUNE_AFTER_MS + MAX_TABLE_ENTRIES + 1;
    expect(classify(table, 'ann', tabA, 1)).toBe('full');
    expect(recordOutcome(table, 'ann', tabA, 1, later)).toBe(table);
    // An empty person already counts as one, so their own new tab still fits.
    expect(classify(table, 'gone0', newSid(later), 1)).toBe('apply');
  });

  it('never drops another person’s live tab to make room: the new tab is refused instead', () => {
    let table: TabTable = {};
    for (let p = 0; p < MAX_TABLE_ENTRIES / MAX_TABS_PER_PERSON; p++) {
      for (let i = 0; i < MAX_TABS_PER_PERSON; i++) table = recordOutcome(table, `p${p}`, newSid(T0 + p * 10 + i), 1, T0 + p * 10 + i);
    }
    const before = JSON.stringify(table);
    expect(classify(table, 'mallory', tabA, 1)).toBe('full');
    expect(recordOutcome(table, 'mallory', tabA, 1, T0 + 9999)).toBe(table);
    expect(JSON.stringify(table)).toBe(before);
    // A person at five tabs still opens a sixth: it drops one of their own.
    const sixth = newSid(T0 + 10_000);
    expect(classify(table, 'p0', sixth, 1)).toBe('apply');
    expect(Object.keys(recordOutcome(table, 'p0', sixth, 1, T0 + 10_000).p0.tabs)).toContain(sixth);
  });

  it('forgets a person 24 hours after their last tab went, watermark and all', () => {
    const emptied = T0 + PRUNE_AFTER_MS + 1;
    let table = prune(recordOutcome({}, 'ann', newSid(T0), 1, T0), emptied);
    expect(table.ann).toEqual({ watermark: T0, tabs: {}, emptySince: emptied });
    expect(prune(table, emptied + PRUNE_AFTER_MS)).toBe(table);
    table = prune(table, emptied + PRUNE_AFTER_MS + 1);
    expect(table.ann).toBeUndefined();
  });

  it('keeps a person whose tab returns before the 24 hours are up', () => {
    const emptied = T0 + PRUNE_AFTER_MS + 1;
    let table = prune(recordOutcome({}, 'ann', newSid(T0), 1, T0), emptied);
    const fresh = newSid(emptied + 5);
    table = recordOutcome(table, 'ann', fresh, 1, emptied + 5);
    expect(table.ann.emptySince).toBeUndefined();
    expect(prune(table, emptied + PRUNE_AFTER_MS + 1).ann.tabs[fresh]).toBeDefined();
  });
});

describe('parseTabTable', () => {
  it('brings a saved table within the bounds, leaves out a reject above its ack, and clamps the watermark', () => {
    const tabs = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [newSid(T0 + i), { ack: 2, lastCommandAt: T0 + i }]));
    const first = Object.keys(tabs)[0];
    tabs[first] = { ...tabs[first], reject: { clientSeq: 9, key: 'noVotesLeft' } } as never;
    const parsed = parseTabTable({ ann: { watermark: T0 + 3_600_000, tabs } }, T0 + 60_000)!;
    expect(Object.keys(parsed.ann.tabs)).toHaveLength(MAX_TABS_PER_PERSON);
    expect(parsed.ann.tabs[first]).toBeUndefined();
    expect(parsed.ann.watermark).toBe(T0 + 60_000);
    const kept = parseTabTable({ ann: { watermark: 0, tabs: { [tabA]: { ack: 2, lastCommandAt: T0, reject: { clientSeq: 3, key: 'noVotesLeft' } } } } })!;
    expect(kept.ann.tabs[tabA]).toEqual({ ack: 2, lastCommandAt: T0 });
  });

  it('drops a loaded table’s extra tabs as an eviction does: the watermark rises and they are refused with tooManyTabs', () => {
    const sids = Array.from({ length: 7 }, (_, i) => newSid(T0 + i));
    const tabs = Object.fromEntries(sids.map((sid, i) => [sid, { ack: 1, lastCommandAt: T0 + i }]));
    const parsed = parseTabTable({ ann: { watermark: 0, tabs } }, T0 + 60_000)!;
    expect(parsed.ann.watermark).toBe(T0 + 1 - CLOCK_SKEW_MS);
    expect(parsed.ann.evicted).toEqual([sids[0], sids[1]]);
    expect(classify(parsed, 'ann', sids[1], 2)).toBe('evicted');
  });

  it('brings a loaded table within the board-wide bound', () => {
    const raw = Object.fromEntries(Array.from({ length: 80 }, (_, p) => [`p${p}`, {
      watermark: 0, tabs: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [newSid(T0 + p * 10 + i), { ack: 1, lastCommandAt: T0 + p * 10 + i }])),
    }]));
    const parsed = parseTabTable(raw, T0 + 60_000)!;
    const entries = Object.values(parsed).reduce((n, p) => n + Math.max(1, Object.keys(p.tabs).length), 0);
    expect(entries).toBeLessThanOrEqual(MAX_TABLE_ENTRIES);
    expect(Object.keys(parsed.p79.tabs)).toHaveLength(5);
    expect(parsed.p0).toBeUndefined();
  });

  it('trims one person with thousands of saved tabs in one pass', () => {
    const n = 10 * MAX_TABLE_ENTRIES - 1;
    const sids = Array.from({ length: n }, (_, i) => newSid(T0 + i));
    const tabs = Object.fromEntries(sids.map((sid, i) => [sid, { ack: 1, lastCommandAt: T0 + i }]));
    const { result: parsed, sorts } = countingSorts(() => parseTabTable({ ann: { watermark: 0, tabs } }, T0 + 1e7)!);
    // One pass: a single sort of all the tabs (n log n comparisons), not a sort for each eviction.
    expect(sorts).toHaveLength(1);
    expect(sorts[0].length).toBe(n);
    expect(sorts[0].comparisons).toBeLessThanOrEqual(2 * n * Math.ceil(Math.log2(n)));
    expect(Object.keys(parsed.ann.tabs).sort()).toEqual(sids.slice(-MAX_TABS_PER_PERSON).sort());
    expect(parsed.ann.evicted).toEqual(sids.slice(n - MAX_TABS_PER_PERSON - 10, n - MAX_TABS_PER_PERSON));
    expect(parsed.ann.watermark).toBe(T0 + n - MAX_TABS_PER_PERSON - 1 - CLOCK_SKEW_MS);
    expect(classify(parsed, 'ann', sids[n - MAX_TABS_PER_PERSON - 1], 1)).toBe('evicted');
    expect(Object.getPrototypeOf(parsed.ann.tabs)).toBeNull();
  });

  it('refuses a saved table with more than ten times the bound in raw entries, before any trimming', () => {
    const many = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [newSid(T0 + i), { ack: 1, lastCommandAt: T0 + i }]));
    const { result, sorts } = countingSorts(() => parseTabTable({ ann: { watermark: 0, tabs: many } }, T0 + 1e7));
    expect(result).toBeNull();
    expect(sorts).toHaveLength(0); // refused before any trimming, so before any sort
    const people = Object.fromEntries(Array.from({ length: 10 * MAX_TABLE_ENTRIES + 1 }, (_, i) => [`p${i}`, { watermark: 0, tabs: {} }]));
    expect(parseTabTable(people, T0)).toBeNull();
  });

  it('trims a large loaded table quickly, with one sort', () => {
    const raw = Object.fromEntries(Array.from({ length: 500 }, (_, p) => [`p${p}`, {
      watermark: 0, tabs: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [newSid(T0 + p * 10 + i), { ack: 1, lastCommandAt: T0 + p * 10 + i }])),
    }]));
    const { result: parsed, sorts } = countingSorts(() => parseTabTable(raw, T0 + 60_000)!);
    // Each person's six tabs are sorted once to trim them; forgetting people to fit the bound is one sort of all 500.
    expect(sorts.filter((sort) => sort.length === 6)).toHaveLength(500);
    expect(sorts.filter((sort) => sort.length > 6)).toHaveLength(1);
    expect(sorts.find((sort) => sort.length > 6)!.length).toBe(500);
    const entries = Object.values(parsed).reduce((n, p) => n + Math.max(1, Object.keys(p.tabs).length), 0);
    expect(entries).toBeLessThanOrEqual(MAX_TABLE_ENTRIES);
    for (const p of Object.values(parsed)) expect(Object.keys(p.tabs).length).toBeLessThanOrEqual(MAX_TABS_PER_PERSON);
    expect(Object.keys(parsed.p499.tabs)).toHaveLength(MAX_TABS_PER_PERSON);
    expect(parsed.p0).toBeUndefined();
  });

  it('accepts a saved table and refuses a malformed one', () => {
    const table = after([tabA, 2, 'noVotesLeft']);
    expect(parseTabTable(JSON.parse(JSON.stringify(table)))).toEqual(table);
    expect(parseTabTable({})).toEqual({});
    expect(parseTabTable(null)).toBeNull();
    expect(parseTabTable({ ann: { watermark: 'x', tabs: {} } })).toBeNull();
    expect(parseTabTable({ ann: { watermark: 0, tabs: { [tabA]: { ack: -1, lastCommandAt: 0 } } } })).toBeNull();
    expect(parseTabTable({ ann: { watermark: 0, tabs: { 'not-a-sid': { ack: 1, lastCommandAt: 0 } } } }, T0)).toEqual({
      ann: { watermark: 0, tabs: {}, emptySince: T0 },
    });
  });

  it('skips reserved or invalid person and sid keys without throwing, and returns null-prototype maps', () => {
    const entry = { ack: 1, lastCommandAt: 0 };
    const payload = JSON.parse(`{
      "__proto__": { "watermark": 0, "tabs": {}, "polluted": "yes" },
      "constructor": { "watermark": 0, "tabs": {} },
      "prototype": { "watermark": 0, "tabs": {} },
      "": { "watermark": 0, "tabs": {} },
      "ann": { "watermark": 0, "tabs": { "__proto__": ${JSON.stringify(entry)}, "constructor": ${JSON.stringify(entry)}, "${tabA}": ${JSON.stringify(entry)} } }
    }`);
    const parsed = parseTabTable(payload)!;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(['ann']);
    expect(Object.keys(parsed.ann.tabs)).toEqual([tabA]);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed.ann.tabs)).toBeNull();
  });
});

describe('own keys only', () => {
  const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

  it('treats such person IDs as ordinary unknown people', () => {
    for (const name of names) {
      expect(classify({}, name, tabA, 1)).toBe('apply');
      expect(deliveryFor({}, name)).toEqual({ acks: {}, rejects: {} });
      const table = recordOutcome({}, name, tabA, 1, T0);
      expect(Object.keys(table)).toEqual([name]);
      expect(classify(table, name, tabA, 2)).toBe('apply');
      expect(Object.getPrototypeOf(table)).toBeNull();
      expect(Object.getPrototypeOf(table[name].tabs)).toBeNull();
      expect(({} as Record<string, unknown>).tabs).toBeUndefined();
      expect(prune(table, T0 + PRUNE_AFTER_MS + 1)[name]).toBeDefined();
    }
  });

  it('drops a several-KB sid and a 1e308 clientSeq: nothing is echoed back', () => {
    const table = after([tabA, 1]);
    expect(classify(table, 'ann', 'x'.repeat(8192), 1)).toBe('drop');
    expect(classify(table, 'ann', `${tabA}${'a'.repeat(8192)}`, 1)).toBe('drop');
    expect(classify(table, 'ann', tabA, 1e308)).toBe('drop');
    expect(classify(table, 'ann', newSid(T0 - 1), 1e308)).not.toBe('stale');
  });

  it('treats such sids as malformed, refused without throwing, for known and unknown people', () => {
    const table = after([tabA, 1]);
    for (const name of names) {
      expect(classify(table, 'ann', name, 1)).toBe('drop');
      expect(classify({}, 'ann', name, 1)).toBe('drop');
    }
  });

  it('refuses an unknown person\'s first command with a malformed sid', () => {
    expect(classify({}, 'ann', 'x', 1)).toBe('drop');
    expect(classify(after([tabA, 1]), 'bob', 'x', 1)).toBe('drop');
  });

  it('keeps null prototypes through every update and prune', () => {
    let table = recordOutcome({}, 'ann', tabA, 1, T0, 'noVotesLeft');
    table = recordOutcome(table, 'ann', tabB, 1, T0 + 2);
    for (const t of [table, prune(table, T0 + PRUNE_AFTER_MS + 5)]) {
      expect(Object.getPrototypeOf(t)).toBeNull();
      expect(Object.getPrototypeOf(t.ann.tabs)).toBeNull();
    }
    expect(Object.getPrototypeOf(table.ann.tabs[tabA].reject)).toBeNull();
  });

  it('returns acks and rejects with null prototypes, the staleTab reject included', () => {
    const table = after([tabA, 1, 'noVotesLeft']);
    const stale = { sid: newSid(T0 - 5), clientSeq: 4, at: T0 + 9000, key: 'staleTab' as const };
    for (const delivery of [deliveryFor(table, 'ann', stale), deliveryFor({}, '__proto__')]) {
      expect(Object.getPrototypeOf(delivery.acks)).toBeNull();
      expect(Object.getPrototypeOf(delivery.rejects)).toBeNull();
    }
    const delivery = deliveryFor(table, 'ann', stale);
    expect(Object.getPrototypeOf(delivery.rejects[stale.sid])).toBeNull();
    expect(delivery.rejects[stale.sid]).toEqual({ clientSeq: 4, key: 'staleTab' });
  });
});
