import type { ViewState } from '../engine/types';

// The line in a guest's People sheet while the facilitator is away, under a list that holds only the guest.
export const HOST_AWAY_PEOPLE_NOTE = "Only the facilitator's device knows who is here, so you see only yourself until it is back.";
export const TIME_UP_WAITING = "Time's up will show when the facilitator is back.";

// Only the facilitator's device knows who is present, so while it is away a guest can't know the others are still here.
// The count then holds the guest alone ("1 here") and the People sheet lists everyone else as offline, rather than
// repeating the last list as if it were current. The guest's own page is, after all, here.
export function viewWhileHostAway<V extends Pick<ViewState, 'online'>>(view: V, you: string): V {
  return { ...view, online: view.online.filter((id) => id === you) };
}

// Whether the People sheet shows the away note: a guest's only, since the facilitator's own device is the one that knows.
export function showHostAwayNote(facilitator: boolean, hostAway: boolean | undefined): boolean {
  return !facilitator && hostAway === true;
}

// A guest's timer that has run out while the facilitator is away: the time-up vote opens on the facilitator's device,
// so nothing changes here until it is back.
export function timeUpWaiting(hostAway: boolean, view: Pick<ViewState, 'timer' | 'vote'>, remainingSeconds: number | null): boolean {
  return hostAway && view.timer !== null && view.vote === null && remainingSeconds !== null && remainingSeconds <= 0;
}
