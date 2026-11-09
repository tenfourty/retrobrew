import type { ComponentChildren } from 'preact';
import type { ViewState } from '../../engine/types';
import type { PresenceEntry } from '../../session/host';
import type { RelayHealth } from '../../transport/types';
import { AttendeeChip, ModeSwitch } from '../../ui/components';
import { Sheet } from '../../ui/sheet';
import { Switch } from '../../ui/switch';
import { HOST_AWAY_PEOPLE_NOTE } from '../host-away';
import { connectionDetails, peopleRows } from '../people';

export const SOUND_SWITCH = 'Play the timer sound on this device';

// The People sheet (docs/product/mvp-screens.md, The board: shared layout): who is here, this device's settings, and
// for the facilitator, how each person is connected and the state of each relay.
export function PeopleSheet(props: {
  open: boolean; onClose: () => void; opener?: HTMLElement | null; view: ViewState; you: string; wide: boolean;
  sound: boolean; onSound: (on: boolean) => void; hostAway?: boolean; feedbackButton?: ComponentChildren;
  presence?: PresenceEntry[]; relays?: RelayHealth[]; oversizeCount?: number;
}) {
  const rows = peopleRows(props.view, props.you, props.presence);
  const details = props.relays ? connectionDetails(props.relays, props.oversizeCount ?? 0) : null;
  return (
    <Sheet open={props.open} title="People" onClose={props.onClose} returnFocusTo={props.opener}>
      <ul className="mtg-people">
        {rows.map((row) => (
          <li key={row.id}>
            <AttendeeChip name={row.name} role={row.role} online={row.online} />
            {row.connection ? <span className="rb-hint">{row.connection}</span> : null}
            {!row.online && !row.connection ? <span className="rb-visually-hidden"> (offline)</span> : null}
          </li>
        ))}
      </ul>
      {props.hostAway ? <p className="rb-hint">{HOST_AWAY_PEOPLE_NOTE}</p> : null}
      <section className="mtg-sheet-section" aria-labelledby="this-device">
        <h3 className="mtg-sheet-heading" id="this-device">This device</h3>
        <Switch label={SOUND_SWITCH} checked={props.sound} onChange={props.onSound} />
        {props.wide ? null : <div className="mtg-device-row"><ModeSwitch />{props.feedbackButton}</div>}
      </section>
      {details ? (
        <details className="mtg-details">
          <summary>Connection details</summary>
          <ul className="mtg-relays">
            {details.relays.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {details.counts.map((line) => <p key={line}>{line}</p>)}
        </details>
      ) : null}
    </Sheet>
  );
}
