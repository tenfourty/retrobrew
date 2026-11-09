import type { ComponentChildren } from 'preact';
import { ModeSwitch } from '../../ui/components';

// The frame for screens without a board: joining, connecting, starting, and broken links. The wordmark links to the
// landing page; leaving is safe here because no meeting is running on this page yet.
export function StatePage(props: { children: ComponentChildren; footer?: ComponentChildren }) {
  return (
    <main className="state">
      <header className="rb-topbar state-top">
        <p className="rb-title"><a className="rb-wordmark" href="/">Retrobrew</a></p>
        <ModeSwitch />
      </header>
      {props.children}
      {props.footer}
    </main>
  );
}

// A panel with one state's words and, where there is one, its action. Polite, because it changes as time passes; an
// alert for a failure.
export function StatePanel(props: { children: ComponentChildren; alert?: boolean }) {
  return <div className="app-panel state-panel" role={props.alert ? 'alert' : 'status'}>{props.children}</div>;
}
