// An exact, bounded memory of entries per person: at most maxPerPerson for each person (that person's own oldest goes
// first) and maxPeople people (the one added longest ago goes). One signer making many entries therefore can't push out
// anyone else's.
export class PerPersonSet {
  private readonly people = new Map<string, Set<string>>();

  constructor(private readonly maxPerPerson: number, private readonly maxPeople: number) {}

  has(personId: string, entry: string): boolean {
    return this.people.get(personId)?.has(entry) ?? false;
  }

  add(personId: string, entry: string): void {
    let set = this.people.get(personId);
    if (set) this.people.delete(personId); // most recently used last
    else set = new Set();
    this.people.set(personId, set);
    set.delete(entry);
    set.add(entry);
    if (set.size > this.maxPerPerson) set.delete(set.values().next().value!);
    if (this.people.size > this.maxPeople) this.people.delete(this.people.keys().next().value!);
  }

  delete(personId: string, entry: string): void {
    const set = this.people.get(personId);
    if (!set?.delete(entry)) return;
    if (!set.size) this.people.delete(personId);
  }

  get size(): number {
    let n = 0;
    for (const set of this.people.values()) n += set.size;
    return n;
  }
}
