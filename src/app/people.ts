import type { ViewState } from '../engine/types';
import type { PeerStatus, RelayHealth } from '../transport/types';

export interface PersonRow {
  id: string;
  // With " (you)" added for the viewer's own row.
  name: string;
  online: boolean;
  role?: 'Facilitator';
  // For the facilitator only: "Direct", "Through relays" or "Offline". Never on the facilitator's own row.
  connection?: string;
}

const CONNECTION: Record<PeerStatus, string> = { direct: 'Direct', relayed: 'Through relays', offline: 'Offline' };
// A person with several tabs is as connected as their best tab.
const RANK: Record<PeerStatus, number> = { direct: 2, relayed: 1, offline: 0 };

// The People sheet's rows: online first, then alphabetical. `presence` is the host's view of each person's path, so
// only the facilitator passes it.
export function peopleRows(view: Pick<ViewState, 'attendees' | 'online'>, you: string, presence?: Array<{ participantId: string; status: PeerStatus }>): PersonRow[] {
  const online = new Set(view.online);
  const paths = new Map<string, PeerStatus>();
  for (const p of presence ?? []) {
    const known = paths.get(p.participantId);
    if (known === undefined || RANK[p.status] > RANK[known]) paths.set(p.participantId, p.status);
  }
  return Object.values(view.attendees)
    .map((a) => {
      const row: PersonRow = { id: a.id, name: a.id === you ? `${a.name} (you)` : a.name, online: online.has(a.id) };
      if (a.role !== 'guest') row.role = 'Facilitator';
      if (presence && a.id !== you) row.connection = CONNECTION[paths.get(a.id) ?? 'offline'];
      return { row, sortName: a.name };
    })
    .sort((a, b) => Number(b.row.online) - Number(a.row.online) || a.sortName.localeCompare(b.sortName, 'en-GB', { sensitivity: 'base' }) || a.row.id.localeCompare(b.row.id))
    .map(({ row }) => row);
}

// The facilitator's "Connection details": each relay and its state, the relays' refusals and notices, and, only once
// it has happened, how many refreshes went out over the relays' size limit (HostSession.oversizeCount).
export function connectionDetails(relays: RelayHealth[], oversizeCount: number): { relays: string[]; counts: string[] } {
  const counts = [
    `Refused by relays: ${relays.reduce((n, r) => n + r.refused, 0)}`,
    `Relay notices: ${relays.reduce((n, r) => n + r.notices, 0)}`,
  ];
  if (oversizeCount > 0) counts.push(`Oversize events: ${oversizeCount}`);
  return { relays: relays.map((r) => `${r.url} · ${r.connected ? 'Connected' : 'Not connected'}`), counts };
}
