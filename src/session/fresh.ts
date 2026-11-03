// What the host remembers of the counted messages (pings, hellos) it has accepted, so each is accepted once: per signer
// and tab, the highest count accepted. An entry lasts until a copy of the message it came from could no longer be fresh
// (the message's `at` is more than freshMs from the host's clock, then and later), not for as long as the signer has a
// record, so expiring a record or forgetting a tab never reopens the window. In memory only: after a host restart a
// copy captured in the last freshMs can be accepted once.
//
// Bounded, in two pools so that minted signers can never push an attendee's counts out:
//  - members (attendees): at most maxTabs tabs per signer (the oldest goes) and maxMembers entries in all; the host
//    passes no limit, since attendees are bounded by the board and a board over the usual limit can have many more;
//  - others (anyone not an attendee): maxOthers entries in all, and when it is full a new entry is REFUSED, never made
//    by evicting an old one. The cost is that a flood of strangers can keep a genuine new joiner's hello from being
//    accepted until entries expire (about freshMs); the benefit is that no copy of an earlier hello is ever accepted
//    because its count was pushed out. (A held entry is refreshed without the pool-full check, and lasts up to about 2 x
// freshMs, so a key holder who keeps sending can keep this pool shut; an observer without the key cannot.)
type Entry = { n: number; until: number };

export class FreshMemory {
  private readonly members = new Map<string, Map<string, Entry>>();
  private readonly others = new Map<string, Map<string, Entry>>();
  private memberCount = 0;
  private otherCount = 0;

  constructor(
    private readonly freshMs: number,
    private readonly maxTabs: number,
    private readonly maxMembers: number,
    private readonly maxOthers: number,
  ) {}

  get size(): number {
    return this.memberCount + this.otherCount;
  }

  get otherSize(): number {
    return this.otherCount;
  }

  signers(): string[] {
    return [...new Set([...this.members.keys(), ...this.others.keys()])];
  }

  tabs(personId: string): string[] {
    return [...(this.members.get(personId)?.keys() ?? []), ...(this.others.get(personId)?.keys() ?? [])];
  }

  // True, and remembered, if `at` (the sender's estimate of the host's clock) is fresh and `n` is higher than the last
  // accepted from this tab (in either pool: a signer that has since joined keeps the counts it made before).
  // member: the signer is an attendee.
  accept(personId: string, sid: string, n: number, at: number, now: number, member = true): boolean {
    if (Math.abs(at - now) > this.freshMs) return false;
    const mine = this.members.get(personId)?.get(sid);
    const theirs = this.others.get(personId)?.get(sid);
    // The boundary matches the freshness test above: a copy with this `at` is still fresh while now <= at + freshMs.
    if (mine && mine.until >= now && n <= mine.n) return false;
    if (theirs && theirs.until >= now && n <= theirs.n) return false;
    // An entry never lasts less than a longer one it replaces: a copy of the older message stays refused as long as
    // it could be fresh, whichever of the two was newer.
    const until = Math.max(Math.max(now, at) + this.freshMs, mine?.until ?? 0, theirs?.until ?? 0);
    const pool = member ? this.members : this.others;
    const has = pool.get(personId)?.has(sid) ?? false;
    if (!member && !has && this.otherCount >= this.maxOthers) return false; // full: refused, nothing evicted
    this.put(pool, member, personId, sid, { n, until });
    // The same tab in the other pool is dropped: this entry now carries its count and its expiry.
    this.remove(member ? this.others : this.members, !member, personId, sid);
    if (member) {
      const tabs = this.members.get(personId)!;
      if (tabs.size > this.maxTabs) this.remove(this.members, true, personId, tabs.keys().next().value!);
      while (this.memberCount > this.maxMembers) this.dropSoonest();
    } else {
      const tabs = this.others.get(personId)!;
      if (tabs.size > this.maxTabs) this.remove(this.others, false, personId, tabs.keys().next().value!);
    }
    return true;
  }

  // Forgets what can no longer matter.
  sweep(now: number): void {
    for (const [pool, member] of [[this.members, true], [this.others, false]] as const) {
      for (const [personId, tabs] of pool) {
        for (const [sid, entry] of [...tabs]) if (entry.until < now) this.remove(pool, member, personId, sid);
      }
    }
  }

  private put(pool: Map<string, Map<string, Entry>>, member: boolean, personId: string, sid: string, entry: Entry): void {
    let tabs = pool.get(personId);
    if (!tabs) pool.set(personId, tabs = new Map());
    if (tabs.delete(sid)) this.bump(member, -1);
    tabs.set(sid, entry);
    this.bump(member, 1);
  }

  private remove(pool: Map<string, Map<string, Entry>>, member: boolean, personId: string, sid: string): void {
    const tabs = pool.get(personId);
    if (!tabs?.delete(sid)) return;
    this.bump(member, -1);
    if (!tabs.size) pool.delete(personId);
  }

  private bump(member: boolean, by: number): void {
    if (member) this.memberCount += by;
    else this.otherCount += by;
  }

  private dropSoonest(): void {
    let soonest: [string, string, number] | null = null;
    for (const [personId, tabs] of this.members) {
      for (const [sid, entry] of tabs) if (!soonest || entry.until < soonest[2]) soonest = [personId, sid, entry.until];
    }
    if (soonest) this.remove(this.members, true, soonest[0], soonest[1]);
  }
}
