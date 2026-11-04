import { useEffect, useState } from 'preact/hooks';
import { isRehearsalLink, isStartLink, parseShareLink } from '../link';
import type { BoardRecord, BoardStore } from '../store/board-store';
import { Home } from './views/Home';
import { HostView } from './views/HostView';
import { ParticipantView } from './views/ParticipantView';
import { StatePage, StatePanel } from './views/StatePage';

type Route = { kind: 'home'; start: boolean; rehearsal: boolean } | { kind: 'bad-link' } | { kind: 'host'; record: BoardRecord } | { kind: 'join'; hash: string };

export function App({ store }: { store: BoardStore }) {
  const [route, setRoute] = useState<Route | null>(null);

  useEffect(() => {
    const resolve = async () => {
      if (!location.hash || isStartLink(location.hash)) {
        setRoute({ kind: 'home', start: isStartLink(location.hash), rehearsal: isRehearsalLink(location.hash) });
        return;
      }
      const link = parseShareLink(location.hash);
      if (!link) { setRoute({ kind: 'bad-link' }); return; }
      const record = await store.get(link.boardId);
      if (record && record.hostPub === link.hostPub && record.hostKeys.privateKey) setRoute({ kind: 'host', record });
      else setRoute({ kind: 'join', hash: location.hash });
    };
    void resolve();
    window.addEventListener('hashchange', resolve);
    return () => window.removeEventListener('hashchange', resolve);
  }, [store]);

  if (!route) return null;
  if (route.kind === 'home') return <Home store={store} start={route.start} rehearsal={route.rehearsal} />;
  if (route.kind === 'bad-link') {
    return (
      <StatePage>
        <StatePanel>
          <h1 className="app-panel-title">This link isn't complete</h1>
          <p>Ask the facilitator to share the meeting link again.</p>
          <p>Or <a className="rb-link" href="#start">start a meeting of your own</a>, or read <a className="rb-link" href="/lean-coffee/">how Lean Coffee works</a>.</p>
        </StatePanel>
      </StatePage>
    );
  }
  if (route.kind === 'host') return <HostView key={route.record.boardId} record={route.record} store={store} />;
  return <ParticipantView key={route.hash} link={parseShareLink(route.hash)!} store={store} />;
}
