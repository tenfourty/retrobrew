import type { ComponentChildren } from 'preact';
import { Button } from './components';

export type BannerTone = 'info' | 'warning' | 'error';

export interface BannerAction { label: string; onClick: (from: HTMLElement) => void; focusFallback?: boolean }

// A full-width message with an optional action (design/system/components/Banner). Banners with an action carry a
// small secondary button; a second action, such as "Send feedback", is a small ghost button beside it.
export function Banner(props: { tone: BannerTone; children: ComponentChildren; action?: BannerAction; secondAction?: BannerAction }) {
  const { action, secondAction } = props;
  const buttons = (
    <>
      {action ? <Button variant="secondary" size="sm" data-focus-fallback={action.focusFallback ? '' : undefined} onClick={(e) => action.onClick(e.currentTarget)}>{action.label}</Button> : null}
      {secondAction ? <Button variant="ghost" size="sm" onClick={(e) => secondAction.onClick(e.currentTarget)}>{secondAction.label}</Button> : null}
    </>
  );
  return (
    <div className={`rb-banner rb-banner-${props.tone}`}>
      <p className="rb-banner-text">{props.children}</p>
      {secondAction ? <div className="rb-banner-actions">{buttons}</div> : buttons}
    </div>
  );
}
