import type { ViewState } from '../../engine/types';
import { ActionBar } from '../../ui/action-bar';
import { Button } from '../../ui/components';
import { barRow, phoneBar, wideBar, type ActionId, type BarAction } from '../action-bar';

// The facilitator action bar (docs/product/mvp-screens.md, The facilitator action bar): sticky at the bottom on
// phones, primary on the right; stacked at the top of the side panel on wide screens. `onAction` passes the clicked
// button, so a sheet it opens can return focus to it.
export function FacilitatorBar(props: { view: ViewState; wide: boolean; readOnly: boolean; copied: boolean; onAction: (id: ActionId, from: HTMLElement) => void }) {
  const row = barRow(props.view);
  const label = (a: BarAction) => (a.id === 'copyText' && props.copied ? 'Copied' : a.label);
  // Keyed by slot, not action: a row change then reuses the button, so a focused primary keeps focus.
  const button = (a: BarAction, variant: 'primary' | 'secondary', slot: string) => (
    <Button key={slot} variant={variant} data-focus-fallback={variant === 'primary' ? '' : undefined} disabled={props.readOnly} onClick={(e) => props.onAction(a.id, e.currentTarget)}>{label(a)}</Button>
  );
  if (props.wide) {
    const bar = wideBar(row);
    return <ActionBar stacked label="Next step">{button(bar.primary, 'primary', 'primary')}{bar.secondaries.map((a, i) => button(a, 'secondary', `secondary-${i}`))}</ActionBar>;
  }
  const bar = phoneBar(row);
  return <ActionBar stacked={false} label="Next step">{bar.other ? button(bar.other, 'secondary', 'other') : null}{button(bar.primary, 'primary', 'primary')}</ActionBar>;
}

// What the phone's "More" sheet lists: that row's secondaries, then (if the row offered "Facilitator") the controls.
export function moreActions(view: ViewState): { actions: BarAction[]; controls: boolean } {
  const bar = phoneBar(barRow(view));
  return { actions: bar.more, controls: bar.moreHasControls };
}
