import { MAX_ATTENDEES } from '../engine/limits';
import { isSid, sidCreatedAt } from '../protocol/sid';

// The host's record of each person's tabs (docs/product/sync-protocol.md, Commands). It is saved with the board,
// in BoardRecord.tabs, so duplicates are still recognised after a host reload. Every function returns a new table.
export const REORDER_WINDOW = 64;
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
export const TABS_PER_VIEW = 3;
// docs/product/sync-protocol.md, Pruning. At most this many tabs per person; a sixth drops the least recently
// active one. The whole table holds at most MAX_TABLE_ENTRIES person-tab entries (a person with no tabs left counts
// as one), whoever they are, attendees or not.
export const MAX_TABS_PER_PERSON = 5;
export const MAX_TABLE_ENTRIES = MAX_TABS_PER_PERSON * MAX_ATTENDEES;
// A stored or imported table with more raw person-tab entries than this is refused, not trimmed.
export const MAX_RAW_ENTRIES = 10 * MAX_TABLE_ENTRIES;
// How many dropped sids each person remembers, so a dropped tab is told why (tooManyTabs). Older ones are refused by
// the host's in-memory filter (src/session/gone-filter.ts) instead, with staleTab.
const EVICTED_KEPT = 2 * MAX_TABS_PER_PERSON;
// A dropped tab raises the watermark only to its creation time less this, so a device whose clock runs up to 10
// minutes slow can still reload after a drop. The host's filter refuses the dropped sids themselves.
export const CLOCK_SKEW_MS = 10 * 60_000;

export interface TabReject {
  clientSeq: number;
  key: string;
}

export interface TabEntry {
  ack: number; // the highest clientSeq applied (or refused) with no gaps
  lastCommandAt: number;
  reject?: TabReject; // the last refusal, until the tab's next command
}

export interface PersonTabs {
  // The creation time of this person's newest pruned or dropped tab, never later than the host's clock was then.
  watermark: number;
  tabs: Record<string, TabEntry>;
  // The sids dropped to keep within the bounds, newest last.
  evicted?: string[];
  // When the person's last tab was pruned or dropped. The entry, watermark and all, is forgotten 24 hours later.
  emptySince?: number;
}

export type TabTable = Record<string, PersonTabs>;

// full: a new tab that would take the table past MAX_TABLE_ENTRIES. It is refused; no other tab makes way for it.
export type Arrival = 'apply' | 'duplicate' | 'buffer' | 'drop' | 'stale' | 'evicted' | 'full';

export interface Delivery {
  acks: Record<string, number>;
  rejects: Record<string, TabReject>;
}

// A command refused because its tab is unknown and older than the watermark (staleTab), or was dropped for a newer
// tab (tooManyTabs), or never filled its gap (staleTab). Held in memory, not saved.
export interface StaleTab {
  sid: string;
  clientSeq: number;
  at: number;
  key: 'staleTab' | 'tooManyTabs';
}

// Every map here has a null prototype and is read by own key only, so a person ID or sid such as "constructor" or
// "__proto__" is an ordinary key and never reaches Object.prototype.
function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function mapOf<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(emptyMap<T>(), entries);
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isPersonId = (x: string): boolean => x.length > 0 && x.length <= 128 && !RESERVED_KEYS.has(x);
const isTabSid = (x: string): boolean => isSid(x) && !RESERVED_KEYS.has(x);

function makeReject(reject: TabReject): TabReject {
  return Object.assign(emptyMap<never>(), { clientSeq: reject.clientSeq, key: reject.key }) as unknown as TabReject;
}

// gone: the host's record of sids that have left the table this session. It is asked about every unknown sid, even
// one whose person has no entry, so forgetting a person never lets their old commands through.
export function classify(
  table: TabTable, personId: string, sid: string, clientSeq: number, gone?: (sid: string) => boolean,
): Arrival {
  // A real tab never makes a malformed sid, so nothing is echoed back for one.
  const createdAt = isSid(sid) ? sidCreatedAt(sid) : null;
  if (createdAt === null) return 'drop';
  const person = own(table, personId);
  const tab = person ? own(person.tabs, sid) : undefined;
  if (!tab) {
    if (person?.evicted?.includes(sid)) return 'evicted';
    if (gone?.(sid)) return 'stale';
    if (person && createdAt <= person.watermark) return 'stale';
  }
  const ack = tab?.ack ?? 0;
  if (clientSeq <= ack) return 'duplicate';
  if (clientSeq === ack + 1) return tab || hasRoom(table, personId) ? 'apply' : 'full';
  if (clientSeq <= ack + REORDER_WINDOW) return 'buffer';
  return 'drop';
}

// The watermark only moves to a creation time the host's clock has reached, so a device whose clock runs ahead
// can't lock out its own later tabs. skew is held back below the creation time (CLOCK_SKEW_MS on a drop).
function raised(watermark: number, sid: string, now: number, skew = 0): number {
  return Math.max(watermark, Math.min((sidCreatedAt(sid) ?? 0) - skew, now));
}

function person(p: PersonTabs): PersonTabs {
  const next: PersonTabs = { watermark: p.watermark, tabs: p.tabs };
  if (p.evicted?.length) next.evicted = p.evicted;
  if (p.emptySince !== undefined) next.emptySince = p.emptySince;
  return next;
}

function withoutTab(p: PersonTabs, sid: string, now: number): PersonTabs {
  const tabs = mapOf(p.tabs);
  delete tabs[sid];
  const next = person({ ...p, watermark: raised(p.watermark, sid, now), tabs });
  if (!Object.keys(tabs).length) next.emptySince = now;
  return next;
}

const entries = (table: TabTable): number => Object.values(table).reduce((n, p) => n + Math.max(1, Object.keys(p.tabs).length), 0);

// Whether a new tab of this person fits: a person at MAX_TABS_PER_PERSON drops one of their own, and a person with
// no tabs already counts as one entry, so neither adds to the table.
export function hasRoom(table: TabTable, personId: string): boolean {
  const p = own(table, personId);
  const n = p ? Object.keys(p.tabs).length : -1;
  const adds = n === 0 || n >= MAX_TABS_PER_PERSON ? 0 : 1;
  return entries(table) + adds <= MAX_TABLE_ENTRIES;
}

// Keeps one person within MAX_TABS_PER_PERSON, dropping their least recently active tab. It never touches anyone
// else's: the board-wide bound is kept by refusing a new tab that doesn't fit (hasRoom), never by dropping a tab.
function trimmed(table: TabTable, personId: string, now: number): TabTable {
  const p = own(table, personId);
  if (!p || Object.keys(p.tabs).length <= MAX_TABS_PER_PERSON) return table;
  return mapOf({ ...table, [personId]: trimPerson(p, now) });
}

// One pass: the tabs are sorted once, the newest MAX_TABS_PER_PERSON kept, and the rest dropped together, the
// watermark raised and the evicted list extended as one eviction each would.
function trimPerson(p: PersonTabs, now: number): PersonTabs {
  const order = Object.entries(p.tabs).sort((a, b) => a[1].lastCommandAt - b[1].lastCommandAt);
  if (order.length <= MAX_TABS_PER_PERSON) return p;
  const dropped = order.slice(0, order.length - MAX_TABS_PER_PERSON).map(([sid]) => sid);
  let watermark = p.watermark;
  for (const sid of dropped) watermark = raised(watermark, sid, now, CLOCK_SKEW_MS);
  const tabs = emptyMap<TabEntry>();
  for (const [sid, tab] of order.slice(-MAX_TABS_PER_PERSON)) tabs[sid] = tab;
  const next = person({ ...p, watermark, tabs });
  delete next.emptySince; // at least one tab is kept
  next.evicted = [...(p.evicted ?? []), ...dropped.slice(-EVICTED_KEPT)].slice(-EVICTED_KEPT);
  return next;
}

// The tab's next command was applied, or refused (rejectKey): either way the ack moves on. Only for a command
// classify said to apply: a new tab that doesn't fit (hasRoom) is never added, so the table never passes the bound.
export function recordOutcome(table: TabTable, personId: string, sid: string, clientSeq: number, now: number, rejectKey?: string): TabTable {
  const tab: TabEntry = { ack: clientSeq, lastCommandAt: now };
  if (rejectKey) tab.reject = makeReject({ clientSeq, key: rejectKey });
  const before = own(table, personId) ?? { watermark: 0, tabs: emptyMap<TabEntry>() };
  const isNew = own(before.tabs, sid) === undefined;
  if (isNew && !hasRoom(table, personId)) return table;
  const p = person({ ...before, tabs: mapOf({ ...before.tabs, [sid]: tab }) });
  delete p.emptySince; // a live tab again
  const next = mapOf({ ...table, [personId]: p });
  return isNew ? trimmed(next, personId, now) : next;
}

// Drops tabs with no command for 24 hours, raising the watermark, and people whose last tab went more than 24 hours
// ago.
export function prune(table: TabTable, now: number): TabTable {
  let changed = false;
  const next: TabTable = emptyMap<PersonTabs>();
  for (const [personId, p] of Object.entries(table)) {
    let kept = p;
    for (const [sid, tab] of Object.entries(p.tabs)) {
      if (now - tab.lastCommandAt <= PRUNE_AFTER_MS) continue;
      kept = withoutTab(kept, sid, now);
      changed = true;
    }
    if (!Object.keys(kept.tabs).length && now - (kept.emptySince ?? now) > PRUNE_AFTER_MS) {
      changed = true;
      continue;
    }
    next[personId] = kept;
  }
  return changed ? next : table;
}

// What one person's view carries: acks and pending rejects for their three most recently active tabs.
// A refused tab (stale) counts as one of the three, since it has just sent. listed (sid -> time) is the host's
// in-memory note of tabs that resent a duplicate: a tab ranks by the later of that and its last command, and the
// note never counts as activity in the table. The tab with the newest command always keeps a slot.
export function deliveryFor(table: TabTable, personId: string, stale?: StaleTab, listed?: Record<string, number>): Delivery {
  const ranked: Array<{ sid: string; at: number; tab?: TabEntry }> = Object.entries(own(table, personId)?.tabs ?? {})
    .map(([sid, tab]) => ({ sid, at: Math.max(tab.lastCommandAt, (listed && own(listed, sid)) ?? Number.NEGATIVE_INFINITY), tab }));
  if (stale) ranked.push({ sid: stale.sid, at: stale.at });
  ranked.sort((a, b) => b.at - a.at);
  // Null-prototype maps, like the table, so a sid can never reach Object.prototype on the way into a view.
  const delivery: Delivery = { acks: emptyMap<number>(), rejects: emptyMap<TabReject>() };
  // The tab that applied a command most recently is the live one: it always has a slot, whatever the listing notes of
  // older tabs say, so copies of their commands can't push its ack out of the view.
  const top = ranked.slice(0, TABS_PER_VIEW);
  const live = ranked.filter((entry) => entry.tab).sort((a, b) => b.tab!.lastCommandAt - a.tab!.lastCommandAt)[0];
  if (live && !top.includes(live)) {
    let slot = top.length - 1;
    while (slot > 0 && (!top[slot].tab || top[slot] === live)) slot -= 1;
    top[slot] = live;
  }
  for (const entry of top) {
    if (!entry.tab) {
      delivery.rejects[entry.sid] = makeReject({ clientSeq: stale!.clientSeq, key: stale!.key });
      continue;
    }
    delivery.acks[entry.sid] = entry.tab.ack;
    if (entry.tab.reject) delivery.rejects[entry.sid] = entry.tab.reject;
  }
  return delivery;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

// Checks a table read from storage or a backup file. Returns null if any part is malformed; reserved or invalid
// person and sid keys are skipped. A table from an older build or an edited file is brought within today's bounds
// as if its extra tabs had been dropped, a reject above its tab's ack is left out, and a watermark ahead of the
// clock is brought back to it.
export function parseTabTable(x: unknown, now = Date.now()): TabTable | null {
  if (!isRecord(x)) return null;
  // Far beyond anything this build saves: refused outright, before any of it is checked or trimmed.
  let raw = 0;
  for (const p of Object.values(x)) {
    raw += isRecord(p) && isRecord(p.tabs) ? Math.max(1, Object.keys(p.tabs).length) : 1;
    if (raw > MAX_RAW_ENTRIES) return null;
  }
  const table: TabTable = emptyMap<PersonTabs>();
  for (const [personId, p] of Object.entries(x)) {
    if (!isPersonId(personId)) continue;
    if (!isRecord(p) || !isCount(p.watermark) || !isRecord(p.tabs)) return null;
    const tabs = emptyMap<TabEntry>();
    for (const [sid, tab] of Object.entries(p.tabs)) {
      if (!isTabSid(sid)) continue;
      if (!isRecord(tab) || !isCount(tab.ack) || !isCount(tab.lastCommandAt)) return null;
      const entry: TabEntry = { ack: tab.ack, lastCommandAt: Math.min(tab.lastCommandAt, now) };
      if (tab.reject !== undefined) {
        const r = tab.reject;
        if (!isRecord(r) || !isCount(r.clientSeq) || typeof r.key !== 'string') return null;
        if (r.clientSeq <= tab.ack) entry.reject = makeReject({ clientSeq: r.clientSeq, key: r.key });
      }
      tabs[sid] = entry;
    }
    const evicted = p.evicted;
    if (evicted !== undefined && (!Array.isArray(evicted) || !evicted.every((s) => typeof s === 'string' && isTabSid(s)))) return null;
    const parsed: PersonTabs = { watermark: Math.min(p.watermark, now), tabs };
    if (evicted?.length) parsed.evicted = (evicted as string[]).slice(-EVICTED_KEPT);
    if (!Object.keys(tabs).length) parsed.emptySince = isCount(p.emptySince) ? Math.min(p.emptySince, now) : now;
    table[personId] = trimPerson(parsed, now);
  }
  return withinBound(table, now);
}

// A loaded table over MAX_TABLE_ENTRIES: the people least recently active are forgotten, entries and all, from one
// sort, until it fits. This is safe at load only: the host session that loads it has a new epoch, so no command from
// before can be replayed into it. During a session nobody is ever forgotten to make room (hasRoom).
function withinBound(table: TabTable, now: number): TabTable {
  let total = entries(table);
  if (total <= MAX_TABLE_ENTRIES) return table;
  const next = mapOf(table);
  const lastActive = (p: PersonTabs) => Math.max(p.emptySince ?? 0, ...Object.values(p.tabs).map((tab) => tab.lastCommandAt));
  const order = Object.entries(table).map(([personId, p]) => ({ personId, at: Math.min(lastActive(p), now), size: Math.max(1, Object.keys(p.tabs).length) }))
    .sort((a, b) => a.at - b.at);
  for (const { personId, size } of order) {
    if (total <= MAX_TABLE_ENTRIES) break;
    delete next[personId];
    total -= size;
  }
  return next;
}
