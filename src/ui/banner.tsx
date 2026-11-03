import type { ComponentChildren } from 'preact';
import { Button } from './components';

export type BannerTone = 'info' | 'warning' | 'error';

// A full-width message with an optional action (design/system/components/Banner). Banners with an action carry a
// small secondary button.
export function Banner(props: { tone: BannerTone; children: ComponentChildren; action?: { label: string; onClick: (from: HTMLElement) => void; focusFallback?: boolean } }) {
  return (
    <div className={`rb-banner rb-banner-${props.tone}`}>
      <p className="rb-banner-text">{props.children}</p>
      {props.action ? <Button variant="secondary" size="sm" data-focus-fallback={props.action.focusFallback ? '' : undefined} onClick={(e) => props.action!.onClick(e.currentTarget)}>{props.action.label}</Button> : null}
    </div>
  );
}
