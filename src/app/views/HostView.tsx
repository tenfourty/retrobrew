import { useEffect, useRef, useState } from 'preact/hooks';
import { redactFor } from '../../engine/redact';
import type { Command } from '../../engine/types';
import type { Outcome } from '../../session/outcome';
import { exportBoard, type BoardRecord, type BoardStore } from '../../store/board-store';
import { Button } from '../../ui/components';
import { Announcer } from '../announcer';
import { countedView } from '../counted-view';
import { COPY, hostBanner, outcomeMs, type BannerAction } from '../banners';
import { acquireBoardLock, downloadText, type BoardLock } from '../browser';
import { takeJustCreated } from '../handoff';
import { recordLink, startHosting, type HostHandle } from '../host-controller';
import { StartCancelled } from '../startup';
import { rememberName } from '../identity';
import { forced, forcedStartError } from '../test-hooks';
import { MeetingScreen, type Refusal } from './MeetingScreen';
import { StatePage, StatePanel } from './StatePage';

export function HostView({ record, store }: { record: BoardRecord; store: BoardStore }) {
  const [, force] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [lost, setLost] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [persistenceDismissed, setPersistenceDismissed] = useState(false);
  // The share step opens by itself the first time the meeting screen shows after creating the meeting.
  const [inviteOnOpen, setInviteOnOpen] = useState(false);
  const handle = useRef<HostHandle | null>(null);
  const lock = useRef<BoardLock | null>(null);
  const starting = useRef<AbortController | null>(null);
  const refusals = useRef(0);
  // The counted view is rebuilt only when the board or who is online changes, not on every render.
  const counted = useRef<{ state: unknown; online: string; view: ReturnType<typeof countedView> } | null>(null);
  const rerender = () => force((n) => n + 1);

  const showOutcome = (next: Outcome) => {
    setOutcome(next);
    setTimeout(() => setOutcome((shown) => (shown === next ? null : shown)), outcomeMs(next));
  };

  // Start-up can be cancelled: if this view goes away, or starts again, the late session is closed, not leaked.
  const begin = async (steal: boolean) => {
    starting.current?.abort();
    const controller = new AbortController();
    starting.current = controller;
    setFailed(null);
    lock.current?.release();
    lock.current = null;
    const acquired = await acquireBoardLock(record.boardId, { steal, onLost: () => { starting.current?.abort(); handle.current?.stop(); setLost(true); } });
    if (controller.signal.aborted) {
      acquired?.release();
      return;
    }
    if (!acquired) {
      setBlocked(true);
      return;
    }
    lock.current = acquired;
    setBlocked(false);
    try {
      const saved = (await store.get(record.boardId)) ?? record;
      if (controller.signal.aborted) return;
      // Browser tests only: the starting and failed states are otherwise too brief or too hard to reach.
      const hosting = forced().hosting;
      if (hosting === 'starting') return;
      const forcedError = forcedStartError();
      if (forcedError) throw forcedError;
      const started = await startHosting(saved, store, rerender, { signal: controller.signal, onOutcome: showOutcome, onHealth: rerender });
      // The view may have gone between start-up finishing and this line running: close the session, don't keep it.
      if (controller.signal.aborted) {
        started.stop();
        return;
      }
      handle.current = started;
      // Straight after creating a meeting, the facilitator sees the share step, once.
      setInviteOnOpen(takeJustCreated(record.boardId));
      rerender();
    } catch (error) {
      // A view that has gone shows nothing, whatever went wrong.
      if (error instanceof StartCancelled || controller.signal.aborted) return;
      // Hosting failed, so the share step has nothing to show: don't keep the note for a later view.
      takeJustCreated(record.boardId);
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void begin(false);
    return () => {
      starting.current?.abort();
      handle.current?.stop();
      lock.current?.release();
    };
  }, [record.boardId]);

  // The hosting states (docs/product/mvp-screens.md, Hosting states).
  if (lost) return <StatePage><StatePanel><h1 className="app-panel-title">This meeting is now open in another tab.</h1></StatePanel></StatePage>;
  if (blocked) {
    return (
      <StatePage>
        <StatePanel>
          <h1 className="app-panel-title">This meeting is open in another tab.</h1>
          <div><Button onClick={() => void begin(true)}>Take over here</Button></div>
        </StatePanel>
      </StatePage>
    );
  }
  if (failed !== null) {
    return (
      <StatePage>
        <StatePanel alert>
          <h1 className="app-panel-title">{COPY.startFailed}</h1>
          <p className="rb-hint">{failed}</p>
          <div><Button onClick={() => void begin(false)}>Try again</Button></div>
        </StatePanel>
      </StatePage>
    );
  }
  const h = handle.current;
  if (!h) return <StatePage><StatePanel><h1 className="app-panel-title">Starting the meeting…</h1></StatePanel></StatePage>;
  const current = h.record();
  const hostId = Object.values(current.state.attendees).find((a) => a.role === 'owner')!.id;
  const backUp = () => downloadText(`${current.state.boardName || 'board'}.retrobrew.json`, exportBoard(current, true));
  const send = (cmd: Command, place?: string) => {
    setRefusal(null);
    void h.session.local(cmd).then((r) => { if (!r.ok) setRefusal({ message: r.message, n: ++refusals.current, place }); });
  };
  const onBannerAction = (action: BannerAction) => {
    if (action === 'dismiss') setPersistenceDismissed(true);
    // 'backUp' never reaches here: the meeting screen asks first (Confirmations), then calls host.onBackUp.
    if (action === 'retry') h.session.retry();
  };

  return (
    <Announcer>
      <MeetingScreen view={redactFor(h.session.current, hostId, { online: h.session.online() })} you={hostId} hostNow={() => h.session.hostNow()}
        send={send} refusal={refusal} readOnly={false} outcome={outcome}
        onRename={(name) => { void h.session.local({ type: 'join', name }); void rememberName(store, name); }}
        banner={hostBanner({ ...h.session, storageNotice: !persistenceDismissed, ...forced().host })} onBannerAction={onBannerAction}
        host={{ link: recordLink(current, location.href), presence: h.session.presence(), relays: h.session.relayHealth(), oversizeCount: h.session.oversizeCount, onBackUp: backUp,
          countedView: (() => {
            const online = h.session.online();
            const key = online.join(' ');
            if (!counted.current || counted.current.state !== h.session.current || counted.current.online !== key) {
              counted.current = { state: h.session.current, online: key, view: countedView(h.session.current, hostId, { online }) };
            }
            return counted.current.view;
          })() }}
        inviteOnOpen={inviteOnOpen} />
    </Announcer>
  );
}
