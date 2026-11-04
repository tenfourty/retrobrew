import { useEffect, useRef, useState } from 'preact/hooks';
import { MESSAGES } from '../../engine/messages';
import { buildShareLink, type ShareLink } from '../../link';
import type { Outcome } from '../../session/outcome';
import type { BoardStore } from '../../store/board-store';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/components';
import { Announcer, useAnnounce } from '../announcer';
import { ACTION_LABEL, bannerTone, participantSignals } from '../banner-choice';
import { COPY, connectingCopy, outcomeMs, participantBanner, type Banner as BannerData, type BannerAction } from '../banners';
import { getDeviceSigner, rememberName } from '../identity';
import { forgetJoined, joinedName, joinRefusalText, joiningTitle, rememberJoined } from '../joined';
import { startParticipating, type ParticipantHandle } from '../participant-controller';
import { unlockAudio } from '../sounds';
import { viewWhileHostAway } from '../host-away';
import { StartCancelled } from '../startup';
import { forced } from '../test-hooks';
import { NAME_HINT } from './Home';
import { MeetingScreen, type Refusal } from './MeetingScreen';
import { StatePage, StatePanel } from './StatePage';

// A banner on a page that has no board yet (the connecting panel, a version mismatch). Retry and Reload work here as
// they do on the board.
function StateBanner(props: { banner: BannerData; onAction: (action: BannerAction) => void }) {
  const { banner } = props;
  const announce = useAnnounce();
  useEffect(() => { announce(banner.text); }, [banner.text]);
  return (
    <Banner tone={bannerTone(banner.text, banner.action)}
      action={banner.action ? { label: ACTION_LABEL[banner.action], onClick: () => props.onAction(banner.action!) } : undefined}>
      {banner.text}
    </Banner>
  );
}

// A participant opening a share link (docs/product/mvp-screens.md, The join screen and Connecting). A device that has
// joined this meeting before skips the form and rejoins silently with the name it used.
export function ParticipantView(props: { link: ShareLink; store: BoardStore }) {
  // One live region for every state, so it never remounts as the page moves from the form to the board.
  return <Announcer><ParticipantBody {...props} /></Announcer>;
}

function ParticipantBody({ link, store }: { link: ShareLink; store: BoardStore }) {
  const [remembered] = useState(() => joinedName(link));
  const [name, setName] = useState(remembered ?? '');
  const [joined, setJoined] = useState(remembered !== null);
  const [nameError, setNameError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const refusals = useRef(0);
  // Set when the person acted on a control that the next state removes (Take part, Retry), so that focus has been lost
  // and the page puts it somewhere; a silent rejoin never had focus anywhere.
  const actedOnControl = useRef(false);
  // Where each command came from, by the number the session gave it, until it is refused or the page goes.
  const places = useRef(new Map<number, string>());
  const [, force] = useState(0);
  const handle = useRef<ParticipantHandle | null>(null);
  const starting = useRef<AbortController | null>(null);
  const rerender = () => force((n) => n + 1);

  // The remembered name arrives late in a fresh browser (it first makes the device's key), so it fills the field only if
  // the person hasn't typed in it yet; otherwise it would wipe what they typed just before they press Take part.
  // A device that has joined this meeting before skips the form and rejoins at once with the name it used.
  useEffect(() => {
    if (remembered !== null) void start(remembered);
    else void getDeviceSigner(store).then((d) => setName((typed) => typed || (d.name ?? '')));
  }, [store]);
  useEffect(() => () => {
    starting.current?.abort();
    handle.current?.stop();
  }, []);
  // The connecting panel's words change at 15 s and 60 s.
  useEffect(() => {
    if (!joined) return undefined;
    const id = setInterval(rerender, 1000);
    return () => clearInterval(id);
  }, [joined]);

  // Start-up can be cancelled: if this view goes away, the late session is closed, not leaked.
  const start = async (as: string) => {
    starting.current?.abort();
    const controller = new AbortController();
    starting.current = controller;
    setFailed(null);
    try {
      const started = await startParticipating(link, as, store, {
        onState: rerender,
        onReject: (text, clientSeq) => { setRefusal({ message: text, n: ++refusals.current, place: places.current.get(clientSeq) }); places.current.delete(clientSeq); },
        onHostStatus: rerender,
        onStatus: rerender,
        onOutcome: (next) => {
          setOutcome(next);
          setTimeout(() => setOutcome((shown) => (shown === next ? null : shown)), outcomeMs(next));
        },
      }, controller.signal);
      // The view may have gone between start-up finishing and this line running: close the session, don't keep it.
      if (controller.signal.aborted) {
        started.stop();
        return;
      }
      handle.current = started;
      rerender();
    } catch (error) {
      // A view that has gone shows nothing, whatever went wrong.
      if (error instanceof StartCancelled || controller.signal.aborted) return;
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };

  const join = (e: Event) => {
    e.preventDefault();
    // This tap also unlocks audio on iOS, so the timer can sound later.
    void unlockAudio().catch(() => undefined);
    if (!name.trim()) {
      setNameError(MESSAGES.emptyName);
      nameInput.current?.focus();
      return;
    }
    setNameError('');
    actedOnControl.current = true;
    // After a refused join, "Take part" tries again on the same session, perhaps under another name.
    const refused = handle.current?.session;
    if (refused?.joinRefused) {
      refused.takePart(name.trim());
      rerender();
      return;
    }
    setJoined(true);
    void start(name.trim());
  };

  const session = handle.current?.session;
  const refusedText = joinRefusalText(session?.joinRefused ?? null);
  const onStateAction = (action: BannerAction) => { if (action === 'retry') session?.retry(); else location.reload(); };
  // Joined: the device remembers it, so coming back skips the form.
  const me = session?.isAttendee && session.you ? session.state?.attendees[session.you] : undefined;
  const boardName = session?.state?.boardName;
  useEffect(() => {
    if (!me) return;
    rememberJoined(link, me.name);
    // "Your meetings" lists it too: the name, the link the person was given and the name they joined under.
    if (boardName) void store.putJoined({ boardId: link.boardId, boardName, link: buildShareLink(location.href, link), name: me.name, joinedAt: Date.now() }).catch(() => undefined);
  }, [me?.name, boardName]);
  // A silent rejoin that the host refuses forgets the stored name, so the form's name sticks once it is entered again.
  const wasRemembered = useRef(remembered !== null);
  useEffect(() => {
    if (!refusedText) return;
    if (wasRemembered.current) {
      forgetJoined(link.boardId);
      wasRemembered.current = false;
    }
    // The connecting panel that had focus is gone: start the form at the name, selected, so another name replaces it.
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [refusedText]);
  // A first view that is already the ended view moves nobody's focus (the meeting screen only moves it when the ending
  // takes it away). Where the person acted on a control that is now gone (Take part, Retry), put focus on the page's own
  // button, unless they have already moved to something else. A silent rejoin lost nothing, so it moves nothing.
  const hasBoard = Boolean(session?.state && session.you && session.isAttendee);
  useEffect(() => {
    if (!hasBoard || session?.state?.phase !== 'ended' || !actedOnControl.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
  }, [hasBoard]);

  if (!joined || refusedText) {
    return (
      <StatePage>
        <form className="app-panel join-panel" noValidate onSubmit={join}>
          <h1 className="app-panel-title">You're invited to a Lean Coffee</h1>
          <p>Choose the name the group will see. The board opens as soon as the facilitator's device answers.</p>
          <div className="rb-field">
            <label className="rb-label" htmlFor="join-name">Your name</label>
            <input ref={nameInput} id="join-name" className="rb-input" maxLength={60} autoComplete="name" value={name}
              aria-invalid={nameError ? 'true' : undefined} aria-describedby={nameError ? 'join-name-hint join-name-error' : 'join-name-hint'}
              onInput={(e) => { setName(e.currentTarget.value); setNameError(''); }} />
            <p className="rb-hint" id="join-name-hint">{NAME_HINT}</p>
            {nameError ? <p className="rb-alert" id="join-name-error" role="alert">{nameError}</p> : null}
          </div>
          {refusedText ? <p className="rb-alert" role="alert">{refusedText}</p> : null}
          <div><Button type="submit">Take part</Button></div>
          <a className="rb-link" href="/lean-coffee/" target="_blank" rel="noopener">How Lean Coffee works</a>
        </form>
      </StatePage>
    );
  }
  if (failed !== null) {
    return (
      <StatePage>
        <StatePanel alert>
          <p>{failed}</p>
          <div><Button variant="secondary" onClick={() => { actedOnControl.current = true; void start(name.trim()); }}>Retry</Button></div>
        </StatePanel>
      </StatePage>
    );
  }
  const banner = session ? participantBanner({ ...participantSignals(session, session.state?.phase === 'ended'), ...forced().participant }) : null;
  // A version mismatch can arrive before any view: the host only ever sends this page a protocol 1 snapshot.
  if (session?.mismatch && !session.state) {
    return <StatePage>{banner ? <StateBanner banner={banner} onAction={onStateAction} /> : null}</StatePage>;
  }
  // Until the host lists this person as an attendee (a first join, or a retry after a refusal) there is no board to use.
  if (!session?.state || !session.you || !session.isAttendee) {
    const copy = connectingCopy(session ? Date.now() - session.connectingSince : 0);
    // The connecting panel already says the facilitator can't be reached, so that banner would say it twice.
    const before = banner && banner.text !== COPY.hostOffline ? banner : null;
    const title = joiningTitle(session?.state?.boardName);
    return (
      <StatePage>
        {before ? <StateBanner banner={before} onAction={onStateAction} /> : null}
        <StatePanel>
          {title ? <h1 className="app-panel-title">{title}</h1> : null}
          {copy.lines.map((line) => <p key={line}>{line}</p>)}
          {copy.retry && session ? <div><Button variant="secondary" onClick={() => { actedOnControl.current = true; session.retry(); }}>Retry</Button></div> : null}
        </StatePanel>
      </StatePage>
    );
  }
  // While the host is offline, or the versions don't match, the board stays visible and read-only.
  const readOnly = !session.hostOnline || session.mismatch !== null;
  // Only the facilitator's device knows who is present: while it is away the head count holds this guest alone.
  const view = session.hostOnline ? session.state : viewWhileHostAway(session.state, session.you);
  return (
    <>
      <MeetingScreen view={view} hostAway={!session.hostOnline} you={session.you} hostNow={() => session.clock.hostNow(Date.now())}
        send={(cmd, place) => {
          setRefusal(null);
          void session.sendSeq(cmd).then((seq) => { if (seq !== null) places.current.set(seq, place); });
        }} refusal={refusal} readOnly={readOnly} outcome={outcome}
        onRename={(name) => { session.takePart(name); void rememberName(store, name); rerender(); }}
        banner={banner ?? null} onBannerAction={onStateAction} />
    </>
  );
}
