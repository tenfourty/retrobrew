import { useEffect, useState } from 'preact/hooks';
import { isRehearsalLink, isStartLink, parseShareLink } from '../link';
import type { BoardRecord, BoardStore } from '../store/board-store';
import { parseFeedbackHash, type Arrival } from './feedback-arrival';
import { FEEDBACK_BUILT, feedbackEnabled } from './feedback-gate';
import { FeedbackFooter, useFeedbackSheet } from './feedback';
import { NO_MEETING } from './feedback-inputs';
import { Home } from './views/Home';
import { HostView } from './views/HostView';
import { ParticipantView } from './views/ParticipantView';
import { StatePage, StatePanel } from './views/StatePage';

type Route = { kind: 'home'; start: boolean; rehearsal: boolean; arrival: Arrival | null } | { kind: 'bad-link' } | { kind: 'host'; record: BoardRecord } | { kind: 'join'; hash: string };

export function App({ store }: { store: BoardStore }) {
  const [route, setRoute] = useState<Route | null>(null);

  useEffect(() => {
    const resolve = async () => {
      if (!location.hash || isStartLink(location.hash)) {
        setRoute({ kind: 'home', start: isStartLink(location.hash), rehearsal: isRehearsalLink(location.hash), arrival: null });
        return;
      }
      // The landing page's and guide's footer links open the app's feedback sheet over the home page (only in a build with the feature).
      const arrival = FEEDBACK_BUILT && feedbackEnabled() ? parseFeedbackHash(location.hash) : null;
      if (arrival) {
        setRoute({ kind: 'home', start: false, rehearsal: false, arrival });
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
  if (route.kind === 'home') return <Home store={store} start={route.start} rehearsal={route.rehearsal} arrival={route.arrival} />;
  if (route.kind === 'bad-link') return <BadLink />;
  if (route.kind === 'host') return <HostView key={route.record.boardId} record={route.record} store={store} />;
  return <ParticipantView key={route.hash} link={parseShareLink(route.hash)!} store={store} />;
}

function BadLink() {
  const feedback = useFeedbackSheet(() => ({ ...NO_MEETING, page: 'state' }));
  return (
    <StatePage footer={<><FeedbackFooter place="state" wiring={feedback.wiring} open={feedback.open} />{feedback.element}</>}>
      <StatePanel>
        <h1 className="app-panel-title">This link isn't complete</h1>
        <p>Ask the facilitator to share the meeting link again.</p>
        <p>Or <a className="rb-link" href="#start">start a meeting of your own</a>, or read <a className="rb-link" href="/lean-coffee/">how Lean Coffee works</a>.</p>
      </StatePanel>
    </StatePage>
  );
}
