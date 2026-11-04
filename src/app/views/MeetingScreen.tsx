import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { REAL_MINUTE_MS } from '../../engine/discussion';
import { columnOrder } from '../../engine/order';
import { viewVotesLeft } from '../../engine/redact';
import type { Command, TopicView, ViewState } from '../../engine/types';
import type { PresenceEntry } from '../../session/host';
import type { Outcome } from '../../session/outcome';
import type { RelayHealth } from '../../transport/types';
import { ActionList } from '../../ui/action-bar';
import { Badge } from '../../ui/badge';
import { Banner } from '../../ui/banner';
import { Button, ModeSwitch, TopicInput, VoteBudget } from '../../ui/components';
import { cx } from '../../ui/cx';
import { Select } from '../../ui/select';
import { ConfirmDialog, Sheet } from '../../ui/sheet';
import { Switch } from '../../ui/switch';
import { OutcomeLine, type TimeUpChoice } from '../../ui/time-up-vote';
import { barRow, controlsLeftOut, type ActionId } from '../action-bar';
import { announcementsBetween, lengthNotice } from '../announce';
import { useAnnounce } from '../announcer';
import { ACTION_LABEL, bannerTone } from '../banner-choice';
import { COPY, type Banner as BannerData, type BannerAction } from '../banners';
import { useCopyOutcome } from '../copy-outcome';
import { createFocusHold } from '../focus-hold';
import { outcomeLine } from '../decision';
import { refusalPlace } from '../refusal-place';
import { FACILITATOR_LINE, guideLine } from '../guide';
import { shortDate } from '../lengths';
import { setSoundOn, soundOn } from '../prefs';
import { listenForAudioUnlock, playTimerSound, SOUND_OPTIONS } from '../sounds';
import { useInset } from '../use-inset';
import { useWide } from '../use-wide';
import { Confirmations, CopyField, type ConfirmId } from './Confirmations';
import { DiscussionPhase } from './DiscussionPhase';
import { EndedView } from './EndedView';
import { FacilitatorBar, moreActions } from './FacilitatorBar';
import { FacilitatorControls } from './FacilitatorControls';
import { NAME_HINT, nameHint } from './Home';
import { RenameSheet } from './RenameSheet';
import { PeopleSheet, SOUND_SWITCH } from './PeopleSheet';
import { ShareSheet } from './ShareSheet';
import { TimeboxPicker } from './TimeboxPicker';
import { TimeUpSheet } from './TimeUpSheet';
import { DISCUSS_BLOCKED, DISCUSS_BLOCKED_ID, NO_VOTES_HINT_ID } from './TopicItem';
import { TopicsPhase } from './TopicsPhase';

// What only the facilitator's screen gets, from the host session.
export interface HostExtras {
  link: string;
  presence: PresenceEntry[];
  relays: RelayHealth[];
  // Refreshes that went out over the relays' size limit (HostSession.oversizeCount).
  oversizeCount: number;
  // The board with every vote count, even while Show votes hides them on screen, for the facilitator's Copy as text.
  countedView: ViewState;
  onBackUp: () => void;
}

// A refused command's message. n changes with every refusal, so the same message twice is shown and read twice.
export interface Refusal {
  message: string;
  n: number;
  // Where the refused command was sent from ('add', 'card:{n}' or 'top'), recorded with that command, so a late refusal
  // shows next to its own control and not the last one used.
  place?: string;
}

export interface MeetingScreenProps {
  view: ViewState;
  you: string;
  hostNow: () => number;
  send: (cmd: Command, place: string) => void;
  refusal: Refusal | null;
  // The host is offline or the versions don't match: the board stays visible, and nothing can be changed.
  readOnly: boolean;
  // A guest's view while the facilitator's device is away: the timer keeps running on its clock, but time up can't open.
  hostAway?: boolean;
  banner: BannerData | null;
  onBannerAction: (action: BannerAction) => void;
  outcome: Outcome | null;
  host?: HostExtras;
  // Changes this person's name for the meeting (and remembers it on this device).
  onRename: (name: string) => void;
  // Open the share step when the screen first shows: straight after creating the meeting.
  inviteOnOpen?: boolean;
}

export type SheetId = 'share' | 'people' | 'picker' | 'timeUp' | 'more' | 'copyText' | 'deleteTopic' | 'rename' | ConfirmId;

const CONFIRMS: readonly SheetId[] = ['resetVotes', 'raiseVotes', 'endMeeting', 'backUp', 'stopTimer'];

// Every phase uses this frame (docs/product/mvp-screens.md, The board: shared layout): the top bar, the guide line,
// one banner, the board, the facilitator's action bar and controls, and the sheets. One sheet is open at a time.
// A vote that opened this long before the page saw it is not heard.
const STALE_VOTE_MS = 3000;

export function MeetingScreen(props: MeetingScreenProps) {
  const { view, you, host } = props;
  const facilitator = view.role !== 'guest';
  const wide = useWide();
  const announce = useAnnounce();
  const dock = useRef<HTMLDivElement>(null);
  const countedDown = useRef<number | null>(null);
  const [sheet, setSheet] = useState<SheetId | null>(props.inviteOnOpen ? 'share' : null);
  const [sound, setSound] = useState(() => soundOn(facilitator));
  // Safari doesn't focus a button on click, so the button that opened a sheet is kept to return focus to.
  const opener = useRef<HTMLElement | null>(null);
  const [picker, setPicker] = useState<{ topicId: number; restart: boolean; fromVote: boolean } | null>(null);
  const [atDecision, setAtDecision] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  // The add box's text and focus: on phones the action bar hides while it has focus, and a topic starting never
  // switches tabs while it has focus or holds a draft.
  const [draft, setDraft] = useState('');
  const [addFocused, setAddFocused] = useState(false);
  // Focus leaving the add box counts after a short hold (focus-hold.ts), so a tap on a card's button isn't lost to the bar returning.
  const focusHold = useRef(createFocusHold(setAddFocused)).current;
  useEffect(() => focusHold.cancel, []);
  const [deleting, setDeleting] = useState<TopicView | null>(null);
  // The allowance a raise is waiting for confirmation at.
  const [raiseTo, setRaiseTo] = useState<number | null>(null);
  // This page's own time-up ballots, by round, in memory only: never saved, never sent back by the host.
  const [choices, setChoices] = useState<Record<number, TimeUpChoice>>({});
  const left = viewVotesLeft(view);
  const vote = view.vote;
  const discussing = view.topics.find((t) => t.column === 'discussing');
  const { copied, copy } = useCopyOutcome(host?.countedView ?? view);
  // Gone when the board can't change: the meeting has ended, or the host is offline.
  const showAddBox = view.phase !== 'ended' && !props.readOnly;
  const hasDock = !wide && (showAddBox || facilitator);
  useInset(dock, '--mtg-bottom', hasDock);
  // Undo after Move on: the facilitator's, while the line shows and nothing else has started.
  const undoable = facilitator && !props.readOnly && props.outcome?.kind === 'movedOn' && view.phase === 'discussion' && !discussing && !vote ? props.outcome : null;
  // The new timer's minute, so a rehearsal board reads "Keeping going for 30 more seconds".
  // Worked out once per outcome, so a timer that stops within the five seconds doesn't change the wording.
  // It shows in the discussion phase only: a vote closed any other way, and a meeting that ended, show no line.
  const outcome = useMemo(
    // Moved on, then undone: the vote is open again, so the line has nothing left to say.
    () => (props.outcome && view.phase === 'discussion' && !(props.outcome.kind === 'movedOn' && vote) ? outcomeLine(props.outcome, view.timer?.minuteMs ?? REAL_MINUTE_MS, discussing !== undefined) : null),
    [props.outcome, view.phase === 'discussion', discussing !== undefined, vote !== null],
  );

  useEffect(() => {
    if (props.refusal) announce(props.refusal.message);
    afterDelete.current = null;
    returning.current = false;
    // A ballot the host refused wasn't counted: unlock it so this page doesn't show a choice that isn't in the totals.
    if (props.refusal && vote && !vote.voted) {
      setChoices((known) => {
        if (known[vote.round] === undefined) return known;
        const { [vote.round]: _refused, ...rest } = known;
        return rest;
      });
    }
  }, [props.refusal?.n]);
  // The add box mounts again when it moves between the dock and the page (a wide flip) or goes (the meeting ended), and an
  // unmounted field sends no blur: don't keep the facilitator's bar hidden for a focus that is gone.
  useEffect(() => { focusHold.reset(); }, [wide, showAddBox]);
  // A delete dialog for a topic that someone else already deleted has nothing left to confirm.
  useEffect(() => {
    if (deleting && !view.topics.some((t) => t.topicId === deleting.topicId)) {
      setDeleting(null);
      setSheet((open) => (open === 'deleteTopic' ? null : open));
    }
  }, [view.topics, deleting]);
  // Return topic takes away the button that was used (the bar's secondary changes with the row). Once the topic has left
  // Discussing, focus goes to the facilitator's primary action, which is then the next step ("Discuss #n"); a refusal clears it.
  const returning = useRef(false);
  useEffect(() => {
    if (!returning.current || discussing) return;
    returning.current = false;
    document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
  }, [discussing?.topicId]);
  // After a confirmed delete, once the card is gone focus goes to a neighbouring card's first button, or else the column
  // it was in (the Ideas region, To discuss).
  const afterDelete = useRef<{ topicId: number; next: HTMLElement | null; column: HTMLElement | null } | null>(null);
  useEffect(() => {
    const pending = afterDelete.current;
    if (!pending || view.topics.some((t) => t.topicId === pending.topicId)) return;
    afterDelete.current = null;
    const target = pending.next?.isConnected ? pending.next : pending.column?.isConnected ? pending.column : document.querySelector<HTMLElement>('.mtg-pinboard');
    target?.focus();
  }, [view.topics]);
  // The meeting ending takes away whatever had focus (the Vote or End meeting button, the add box): focus goes to the page's
  // fallback, the facilitator's primary button or the participant's Copy as text, and never to the page body.
  const lastPhase = useRef(view.phase);
  // The element that last had focus, to tell whether the ending removed it.
  const hadFocus = useRef<Element | null>(null);
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = view.phase;
    if (view.phase !== 'ended' || was === 'ended') return;
    // Focus moves only if it was lost: it was on something this change removed. A reader with focus on the body keeps it.
    const lost = hadFocus.current !== null && !hadFocus.current.isConnected;
    if (!lost) return;
    document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
  }, [view.phase]);
  useEffect(() => {
    const onIn = (e: FocusEvent) => { hadFocus.current = e.target as Element; };
    // A blur because the element was removed does not count as the reader moving on: only a blur from an element still on the page clears it.
    const onOut = (e: FocusEvent) => {
      const el = e.target as Element;
      queueMicrotask(() => { if (hadFocus.current === el && el.isConnected) hadFocus.current = null; });
    };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut); };
  }, []);
  useEffect(() => {
    if (props.banner) announce(props.banner.text);
  }, [props.banner?.text]);
  useEffect(() => {
    if (outcome) announce(outcome);
  }, [props.outcome]);
  // Phase changes ("Meeting ended" among them), a topic starting and time up go through the live region as each new
  // view arrives. The first view announces nothing.
  const previousDraft = useRef('');
  useEffect(() => {
    const said = lengthNotice(previousDraft.current, draft);
    previousDraft.current = draft;
    if (said) announce(said);
  }, [draft]);
  const previous = useRef<ViewState | null>(null);
  useEffect(() => {
    for (const line of announcementsBetween(previous.current, view)) announce(line);
    previous.current = view;
  }, [view]);

  // The time-up sheet opens by itself when a vote opens, above anything else: whatever sheet was open closes, keeping
  // nothing half-done. It also opens for someone whose first view already has the vote open, and closes when the vote does.
  // The timer sound plays here too, once for each vote this page saw open (a change of voteKey, never a re-render, a
  // reconnect or a layout flip), where the device switch is on. The first run only records what the view already
  // showed, so a late joiner, or a page that rejoins after time up, hears nothing.
  const voteKey = vote ? `${vote.topicId}:${vote.round}` : '';
  const shownVote = useRef('');
  const sawFirstView = useRef(false);
  useEffect(() => {
    if (voteKey && voteKey !== shownVote.current) {
      opener.current = null;
      setAtDecision(false);
      setCopyFallback(null);
      setSheet('timeUp');
      // Stale: the timer ended well before this page saw the vote open, as when a locked phone wakes or a page
      // rejoins. The host's clock decides, not the wall clock, so a hidden tab that kept running still sounds on time.
      const endsAt = view.timer?.endsAt;
      const stale = endsAt !== undefined && props.hostNow() - endsAt > STALE_VOTE_MS;
      if (sawFirstView.current && sound && !stale) playTimerSound(view.timerSound);
    }
    if (!voteKey) setSheet((open) => (open === 'timeUp' ? null : open));
    shownVote.current = voteKey;
    sawFirstView.current = true;
    // Deps are only [voteKey] on purpose: the sound is played once per vote opening, so `sound`, `view.timerSound`
    // and the clock are read as they are when the vote opens and must not re-run this effect.
  }, [voteKey]);
  // iOS: a tap of any kind unlocks audio for the page, including after a silent rejoin, which has no Take part tap.
  useEffect(() => listenForAudioUnlock(), []);

  // A control inside a sheet that opens another sheet keeps the first opener: the button on the page that started it.
  const remember = (from: HTMLElement | null) => { if (!from?.closest('dialog')) opener.current = from; };
  const openSheet = (id: SheetId, from: HTMLElement) => { remember(from); setSheet(id); };
  const closeSheet = () => { setSheet(null); setCopyFallback(null); };
  const changeSound = (on: boolean) => { setSoundOn(on); setSound(on); };
  const openPicker = (topicId: number, restart: boolean, from?: HTMLElement) => {
    if (from) remember(from); else opener.current = null;
    setPicker({ topicId, restart, fromVote: !from });
    setSheet('picker');
  };
  const openVote = (decision: boolean, from: HTMLElement) => { setAtDecision(decision); openSheet('timeUp', from); };
  // A command from the add box, a topic or elsewhere: its refusal shows next to the control that sent it.
  const sendFrom = (from: string) => (cmd: Command) => props.send(cmd, from);
  const send = sendFrom('top');
  // A refusal for a topic that is no longer on the board has no card to sit beside, so it shows at the top.
  const refusedAt = refusalPlace(props.refusal?.place, view.topics.map((t) => t.topicId));
  const alertFor = (from: string) => (props.refusal && refusedAt === from ? props.refusal.message : undefined);
  const askDelete = (topic: TopicView, from: HTMLElement | null) => {
    setDeleting(topic);
    if (from) openSheet('deleteTopic', from); else { opener.current = null; setSheet('deleteTopic'); }
  };
  const startTimer = (minutes: number, realMinutes: boolean) => {
    if (!picker) return;
    const extra = realMinutes ? { realMinutes: true } : {};
    send(picker.restart
      ? { type: 'restartTimer', topicId: picker.topicId, minutes, ...extra }
      : { type: 'discussTopic', topicId: picker.topicId, minutes, ...extra });
    setSheet(null);
    // "New timebox" came from the time-up sheet, which is gone now, and the Vote chip went with the vote. Focus lands on the
    // page's fallback target: the facilitator's bar, whose primary button follows the new timer. A restart from the
    // action bar returns focus to the bar itself.
    if (picker.fromVote) setTimeout(() => document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus(), 0);
  };
  // Cancelling "New timebox" goes back to the vote it interrupted; any other Cancel returns to its opener.
  const cancelPicker = () => {
    if (picker?.restart && vote) { setAtDecision(true); setSheet('timeUp'); } else closeSheet();
  };
  // Copy as text from the action bar: if the clipboard is refused, the text opens in a sheet to copy by hand.
  const copyFromBar = async (from: HTMLElement) => {
    const refused = await copy();
    if (refused !== null) { setCopyFallback(refused); openSheet('copyText', from); }
  };
  // From the End meeting dialog: copies without closing it.
  const copyFromConfirm = async () => setCopyFallback(await copy());

  const onAction = (id: ActionId, from: HTMLElement) => {
    const fromMore = sheet === 'more';
    if (id === 'copyText') { void copyFromBar(from); return; }
    if (id === 'reopen') send({ type: 'reopenMeeting' });
    else if (id === 'backUp') openSheet('backUp', from);
    else if (id === 'decide') openVote(true, from);
    else if (id === 'stopTimer' && discussing) openSheet('stopTimer', from);
    else if (id === 'more') openSheet('more', from);
    else if (id === 'finish' && discussing) send({ type: 'finishTopic', topicId: discussing.topicId });
    else if (id === 'returnTopic' && discussing) { returning.current = true; send({ type: 'returnTopic', topicId: discussing.topicId }); }
    else if (id === 'startTimer' && discussing) openPicker(discussing.topicId, true, from);
    else if (id === 'discussNext') {
      const next = columnOrder(view, 'toDiscuss')[0];
      if (next) openPicker(next.topicId, false, from);
    } else if (id === 'backToTopics') send({ type: 'backToTopics' });
    else if (id === 'endMeeting') openSheet('endMeeting', from);
    else if (id === 'startDiscussion') send({ type: 'startDiscussion' });
    else if (id === 'invite') openSheet('share', from);
    // An action in the More sheet that opens no sheet of its own closes it.
    const opensSheet = ['backUp', 'stopTimer', 'decide', 'startTimer', 'discussNext', 'endMeeting', 'invite', 'copyText'].includes(id);
    if (fromMore && !opensSheet) closeSheet();
  };
  const onBannerAction = (action: BannerAction) => {
    // Backing up always goes through the warning about the meeting's keys.
    if (action === 'backUp') { opener.current = null; setSheet('backUp'); }
    else props.onBannerAction(action);
  };

  // The board's timer sound is the facilitator's to pick; Play previews it on this device only, and the switch is this device's.
  const soundControls = (
    <div className="mtg-sound">
      <div className="mtg-sound-row">
        <Select label="Timer sound" value={view.timerSound} options={SOUND_OPTIONS} disabled={props.readOnly}
          onChange={(id) => send({ type: 'setTimerSound', sound: id })} />
        <Button variant="ghost" size="sm" onClick={() => playTimerSound(view.timerSound)}>Play</Button>
      </div>
      <Switch label={SOUND_SWITCH} checked={sound} onChange={changeSound} />
    </div>
  );
  const myName = view.attendees[you]?.name;
  const row = barRow(view);
  // Each facilitator button shows once: the controls leave out what the bar beside them (wide) or the More list above them offers.
  const controlsFor = (where: 'wide' | 'more') => (
    <FacilitatorControls view={view} leaveOut={controlsLeftOut(row, where)} readOnly={props.readOnly}
      send={(cmd) => { if (cmd.type === 'returnTopic') returning.current = true; send(cmd); }} onInvite={(from) => openSheet('share', from)}
      onResetVotes={(from) => openSheet('resetVotes', from)} onRaiseVotes={(votes, from) => { setRaiseTo(votes); openSheet('raiseVotes', from); }} onEndMeeting={(from) => openSheet('endMeeting', from)} sound={soundControls} />
  );
  const more = moreActions(view);
  // Phones have no mode switch in the top bar: the facilitator finds it at the foot of the More sheet, and
  // a guest in the People sheet (which has no bar to put it in).
  const displaySection = (
    <section className="mtg-sheet-section" aria-labelledby="sheet-display">
      <h3 className="mtg-sheet-heading" id="sheet-display">Display</h3>
      <div><ModeSwitch /></div>
    </section>
  );
  // The add box: above the board on wide screens, pinned to the bottom of the screen on phones.
  const addBox = showAddBox ? (
    <div className="mtg-add">
      {alertFor('add') ? <p className="rb-alert">{alertFor('add')}</p> : null}
      <TopicInput value={draft} onValueChange={setDraft} onFocus={focusHold.focus} onBlur={focusHold.blur}
        cta={view.phase === 'discussion' && view.topics.length > 0 ? 'Add another topic' : 'Add topic'}
        hint={myName ? nameHint(myName) : NAME_HINT} hintAction={myName && !props.readOnly ? { label: 'Change', onClick: (from) => openSheet('rename', from) } : undefined}
        onAdd={(text) => sendFrom('add')({ type: 'addTopic', text })} />
    </div>
  ) : null;
  const sidePanel = facilitator && wide;
  // On an ended meeting the ended banner always wins for a participant, so no connection banner shows; for the facilitator
  // it wins over the storage notice, which is only advice, but not over a failed save or the network.
  const shown = view.phase === 'ended' && (!facilitator || props.banner?.text === COPY.storageNotice) ? null : props.banner;
  const action = shown?.action;

  return (
    <div className={cx('mtg', sidePanel && 'mtg-with-side')}>
      <header className="rb-topbar mtg-top">
        <div className="mtg-heading">
          <div className="mtg-title-row">
            <h1 className="rb-title">{view.boardName}</h1>
            {view.rehearsal ? <Badge>Rehearsal</Badge> : null}
          </div>
          <p className="rb-sub mtg-guide">
            <span>{guideLine(view.phase, facilitator, view.voteAllowance)}</span>
            <a className="rb-link" href="/lean-coffee/" target="_blank" rel="noopener">How Lean Coffee works</a>
          </p>
          {facilitator && view.phase !== 'ended' ? <p className="rb-sub">{FACILITATOR_LINE}</p> : null}
        </div>
        <div className="mtg-top-end">
          <Button variant="ghost" size="sm" onClick={(e) => openSheet('people', e.currentTarget)}>{`${view.online.length} here`}</Button>
          {view.phase === 'ended' ? null : <VoteBudget total={view.voteAllowance} used={view.voteAllowance - left} />}
          {wide ? <ModeSwitch /> : null}
        </div>
      </header>
      {shown ? (
        <div className="mtg-banner">
          <Banner tone={bannerTone(shown.text, action)}
            action={action ? { label: ACTION_LABEL[action], onClick: () => onBannerAction(action) } : undefined}>
            {shown.text}
          </Banner>
        </div>
      ) : null}
      {/* One banner at a time. The facilitator's banner about saving or the network outranks this one, because it may need
          acting on; for a participant the ended banner always wins, and holds Copy as text. */}
      {view.phase === 'ended' && !shown ? (
        <div className="mtg-banner">
          <Banner tone="info"
            action={facilitator ? undefined : { label: copied ? 'Copied' : 'Copy as text', focusFallback: true, onClick: (from) => void copyFromBar(from) }}>
            {view.endedAt ? `Meeting ended · ${shortDate(view.endedAt)}` : 'Meeting ended'}
          </Banner>
        </div>
      ) : null}
      {/* The outcome line sits inside the discussion phase: under the strip on phones, in the Discussing column on wide screens. */}
      {alertFor('top') ? <p className="rb-alert mtg-refusal">{alertFor('top')}</p> : null}
      <span id={NO_VOTES_HINT_ID} hidden>You have no votes left</span>
      <span id={DISCUSS_BLOCKED_ID} hidden>{DISCUSS_BLOCKED}</span>
      <div className="mtg-body">
        <div className="mtg-main">
          {wide ? addBox : null}
          {view.phase === 'topics' ? (
            <TopicsPhase view={view} you={you} facilitator={facilitator} readOnly={props.readOnly} votesLeft={left}
              send={(cmd, from) => sendFrom(from)(cmd)} onDelete={askDelete} alertFor={alertFor} />
          ) : null}
          {view.phase === 'ended' ? <EndedView view={view} you={you} facilitator={facilitator} /> : null}
          {view.phase === 'discussion' ? (
            <DiscussionPhase view={view} you={you} facilitator={facilitator} readOnly={props.readOnly} votesLeft={left} wide={wide}
              hostNow={props.hostNow} hostAway={props.hostAway ?? false} countedDown={countedDown} typing={addFocused || draft.trim() !== ''}
              outcome={outcome ? (
                <OutcomeLine action={undoable ? <Button variant="ghost" size="sm" onClick={() => send({ type: 'undoMoveOn', topicId: undoable.topicId })}>Undo</Button> : undefined}>{outcome}</OutcomeLine>
              ) : null}
              send={(cmd, from) => sendFrom(from)(cmd)} onDelete={askDelete} alertFor={alertFor}
              onDiscuss={(topicId, from) => openPicker(topicId, false, from)} onOpenVote={(from) => openVote(false, from)} />
          ) : null}
        </div>
        {sidePanel ? (
          <aside className="mtg-side" aria-label="Facilitator">
            <FacilitatorBar view={view} wide readOnly={props.readOnly} copied={copied} onAction={onAction} />
            {/* Every row offers the Facilitator controls, which wide screens show in place. */}
            {view.phase === 'ended' ? null : (
              <section className="mtg-side-section" aria-labelledby="facilitator-controls">
                <h2 className="mtg-side-title" id="facilitator-controls">Facilitator</h2>
                {controlsFor('wide')}
              </section>
            )}
          </aside>
        ) : null}
      </div>
      {hasDock ? (
        <div className="mtg-dock" ref={dock}>
          {addBox}
          {facilitator && !addFocused ? <FacilitatorBar view={view} wide={false} readOnly={props.readOnly} copied={copied} onAction={onAction} /> : null}
        </div>
      ) : null}

      <PeopleSheet open={sheet === 'people'} onClose={closeSheet} opener={opener.current} view={view} you={you} wide={wide} sound={sound} onSound={changeSound}
        presence={host?.presence} relays={host?.relays} oversizeCount={host?.oversizeCount} />
      {host ? <ShareSheet open={sheet === 'share'} link={host.link} meetingName={view.boardName} opener={opener.current} onClose={closeSheet} /> : null}
      <TimeboxPicker open={sheet === 'picker'} opener={opener.current} topic={view.topics.find((t) => t.topicId === picker?.topicId)}
        restart={picker?.restart ?? false} rehearsal={view.rehearsal} onStart={startTimer} onClose={cancelPicker} />
      {vote ? (
        <TimeUpSheet open={sheet === 'timeUp'} opener={opener.current} onClose={closeSheet} view={view} facilitator={facilitator} readOnly={props.readOnly}
          atDecision={atDecision} choice={choices[vote.round]}
          onVote={(choice) => {
            setChoices((known) => ({ ...known, [vote.round]: choice }));
            send({ type: 'voteToContinue', topicId: vote.topicId, round: vote.round, choice });
          }}
          onKeepGoing={(minutes) => { send({ type: 'extendTopic', topicId: vote.topicId, round: vote.round, minutes }); setSheet(null); }}
          onMoveOn={() => { send({ type: 'finishTopic', topicId: vote.topicId }); setSheet(null); }}
          onStartAgain={() => openPicker(vote.topicId, true)} />
      ) : null}
      <RenameSheet open={sheet === 'rename'} current={myName ?? ''} returnFocusTo={opener.current} onClose={closeSheet}
        onSave={(name) => { if (name !== myName) props.onRename(name); closeSheet(); }} />
      <Sheet open={sheet === 'copyText'} title="Copy as text" onClose={closeSheet} returnFocusTo={opener.current}>
        {copyFallback !== null ? <CopyField text={copyFallback} /> : null}
      </Sheet>
      {deleting ? (
        <ConfirmDialog open={sheet === 'deleteTopic'} title={`Delete #${deleting.topicId}?`} onCancel={closeSheet} returnFocusTo={opener.current}
          body={<><p className="mtg-sheet-topic">{deleting.text}</p><p>The topic and its votes are removed, and everyone gets those votes back.</p></>}
          actions={[{ label: 'Delete topic', variant: 'danger', onClick: () => {
            const card = opener.current?.closest('article') ?? null;
            // The neighbour is the next topic card, else the previous one; headings and notes between cards don't count, and
            // a card with no enabled button (a read-only board) hands focus to its column instead.
            const cards = [...(card?.parentElement?.querySelectorAll(':scope > article') ?? [])];
            const at = card ? cards.indexOf(card) : -1;
            const neighbour = cards[at + 1] ?? cards[at - 1];
            afterDelete.current = {
              topicId: deleting.topicId, next: neighbour?.querySelector<HTMLElement>('button:not([disabled])') ?? null,
              column: card?.closest<HTMLElement>('section') ?? null,
            };
            sendFrom(`card:${deleting.topicId}`)({ type: 'deleteTopic', topicId: deleting.topicId });
            closeSheet();
          } }]} />
      ) : null}
      {facilitator ? (
        <>
          <Sheet open={sheet === 'more'} title="More" onClose={closeSheet} returnFocusTo={opener.current}>
            {more.actions.length > 0 ? <ActionList actions={more.actions.map((a) => ({ label: a.label, onClick: (from) => onAction(a.id, from) }))} /> : null}
            {more.controls ? <section className="mtg-sheet-section" aria-label="Facilitator controls">{controlsFor('more')}</section> : null}
            {displaySection}
          </Sheet>
          <Confirmations open={sheet !== null && CONFIRMS.includes(sheet) ? (sheet as ConfirmId) : null} view={view} raiseTo={raiseTo} opener={opener.current} onCancel={closeSheet}
            onRaiseVotes={() => { if (raiseTo !== null) send({ type: 'raiseAllowance', votes: raiseTo }); closeSheet(); }}
            onResetVotes={() => { send({ type: 'clearVotes' }); closeSheet(); }}
            onEndMeeting={() => { send({ type: 'endMeeting' }); closeSheet(); }}
            onStopTimer={() => { if (discussing) send({ type: 'stopTimer', topicId: discussing.topicId }); closeSheet(); }}
            onBackUp={() => { host?.onBackUp(); closeSheet(); }}
            onCopy={() => void copyFromConfirm()} copied={copied} copyFallback={copyFallback} />
        </>
      ) : null}
    </div>
  );
}
