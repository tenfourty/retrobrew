import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_RELAYS } from '../../config';
import { saveImportedBoard, type BoardRecord, type BoardStore, type JoinedRecord } from '../../store/board-store';
import { Badge } from '../../ui/badge';
import { Button, ModeSwitch } from '../../ui/components';
import { boardIsHosted } from '../browser';
import { exclusive } from '../exclusive';
import { markJustCreated } from '../handoff';
import { createBoardRecord, recordLink } from '../host-controller';
import { getDeviceSigner, rememberName } from '../identity';
import { checkFileSize, meetingStatus, readMeetingFile } from '../meeting-file';
import { recordPersistence, storeNewMeeting } from '../persistence';
import { meetingRows, removeBody, removeMeeting, removeTitle, rowStatus, type MeetingRow } from '../your-meetings';
import { ConfirmDialog } from '../../ui/sheet';

// The line beside the rehearsal link: what a rehearsal changes.
export const REHEARSAL_LINE = 'A minute lasts 10 seconds, so you can see a whole meeting in a few minutes';
export const NAME_HINT = 'Everyone in the meeting sees this name next to the topics you add';
// Inside the meeting the hint names the name, so it is never a notice about nothing.
export const nameHint = (name: string) => `You are ${name}. ${NAME_HINT}`;

// The app home (docs/product/mvp-screens.md, The app home): start a meeting, or open one started in this browser.
// /app/#start focuses the form; /app/#start&rehearsal creates a rehearsal board.
export function Home({ store, start = false, rehearsal = false }: { store: BoardStore; start?: boolean; rehearsal?: boolean }) {
  const [boards, setBoards] = useState<BoardRecord[]>([]);
  const [joined, setJoined] = useState<JoinedRecord[]>([]);
  const [removing, setRemoving] = useState<MeetingRow | null>(null);
  const [removeError, setRemoveError] = useState('');
  const removeOpener = useRef<HTMLElement | null>(null);
  const [boardName, setBoardName] = useState('');
  const [yourName, setYourName] = useState('');
  const [errors, setErrors] = useState({ meeting: '', you: '' });
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const single = useRef(exclusive()).current;
  const meetingInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (start) meetingInput.current?.focus();
  }, [start, rehearsal]);

  useEffect(() => {
    void store.list().then(setBoards);
    void store.listJoined().then(setJoined);
    // The remembered name can arrive after the person has started typing (a fresh browser first makes the device's
    // key): it fills "Your name" only if they haven't typed in it yet.
    void getDeviceSigner(store).then(({ name }) => setYourName((typed) => typed || (name ?? '')));
  }, [store]);

  const open = (record: BoardRecord) => { location.hash = new URL(recordLink(record, location.href)).hash; };

  const create = async (e: Event) => {
    e.preventDefault();
    const meeting = boardName.trim();
    const you = yourName.trim();
    setErrors({ meeting: meeting ? '' : 'Enter a meeting name', you: you ? '' : 'Enter your name' });
    if (!meeting) { meetingInput.current?.focus(); return; }
    if (!you) { nameInput.current?.focus(); return; }
    // While the browser's storage prompt is open the controls are off, so a second tap can't make a second meeting.
    await single(async () => {
      setBusy(true);
      try {
        const record = await createBoardRecord(meeting, you, DEFAULT_RELAYS, rehearsal);
        // Saved first; banner 6 tells the facilitator if the browser won't promise to keep the meeting.
        const [saved] = await Promise.all([storeNewMeeting(store, record), rememberName(store, you)]);
        // The host view opens the share step once, straight after this.
        markJustCreated(saved.boardId);
        open(saved);
      } finally {
        setBusy(false);
      }
    });
  };

  const openFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // Cleared so choosing the same file again still counts as a change.
    input.value = '';
    if (!file) return;
    setFileError('');
    await single(async () => {
      setBusy(true);
      try {
        checkFileSize(file.size);
        const record = await saveImportedBoard(store, await readMeetingFile(await file.text()), boardIsHosted);
        // The file's note, if any, was dropped: this browser is asked, as for a new meeting.
        open(await recordPersistence(store, record));
      } catch (err) {
        setFileError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    });
  };

  const remove = async (row: MeetingRow) => {
    setRemoving(null);
    const refused = await removeMeeting(store, row, boardIsHosted);
    setRemoveError(refused ?? '');
    if (refused === null) {
      setBoards((was) => was.filter((b) => b.boardId !== row.boardId));
      setJoined((was) => was.filter((j) => j.boardId !== row.boardId));
    }
  };

  const rows = meetingRows(boards, joined);
  const guide = (where: 'top' | 'bottom') => <a className={`rb-link home-guide-${where}`} href="/lean-coffee/">How Lean Coffee works</a>;

  return (
    <main className="home">
      <header className="rb-topbar home-top">
        <h1 className="rb-title"><a className="rb-wordmark" href="/">Retrobrew</a></h1>
        <div className="home-top-end">
          {guide('top')}
          <ModeSwitch />
        </div>
      </header>
      <div className="home-panels">
        <form className="app-panel" noValidate onSubmit={(e) => void create(e)}>
          <h2 className="app-panel-title">{rehearsal ? 'Start a rehearsal meeting' : 'Start a meeting'}</h2>
          {rehearsal ? <p className="rb-sub">Timeboxes are shortened, for trying things out</p> : null}
          <div className="rb-field">
            <label className="rb-label" htmlFor="meeting-name">Meeting name</label>
            <input ref={meetingInput} id="meeting-name" className="rb-input" maxLength={80} placeholder="Team Lean Coffee"
              value={boardName} aria-invalid={errors.meeting ? 'true' : undefined} aria-describedby={errors.meeting ? 'meeting-name-error' : undefined}
              onInput={(e) => { setBoardName(e.currentTarget.value); setErrors((was) => ({ ...was, meeting: '' })); }} />
            {errors.meeting ? <p className="rb-alert" id="meeting-name-error" role="alert">{errors.meeting}</p> : null}
          </div>
          <div className="rb-field">
            <label className="rb-label" htmlFor="your-name">Your name</label>
            <input ref={nameInput} id="your-name" className="rb-input" maxLength={60} autoComplete="name"
              value={yourName} aria-invalid={errors.you ? 'true' : undefined}
              aria-describedby={errors.you ? 'your-name-hint your-name-error' : 'your-name-hint'}
              onInput={(e) => { setYourName(e.currentTarget.value); setErrors((was) => ({ ...was, you: '' })); }} />
            <p className="rb-hint" id="your-name-hint">{NAME_HINT}</p>
            {errors.you ? <p className="rb-alert" id="your-name-error" role="alert">{errors.you}</p> : null}
          </div>
          <div><Button type="submit" disabled={busy}>Create meeting</Button></div>
          {busy ? <p className="rb-hint" role="status">Saving the meeting…</p> : null}
          {rehearsal ? (
            <p className="rb-hint"><a className="rb-link" href="#start">Start a normal meeting instead</a></p>
          ) : (
            <p className="rb-hint"><a className="rb-link" href="#start&rehearsal">Try a quick rehearsal</a>{` ${REHEARSAL_LINE}`}</p>
          )}
        </form>
        {guide('bottom')}
        <section className="app-panel" aria-labelledby="your-meetings">
          <h2 className="app-panel-title" id="your-meetings">Your meetings</h2>
          {rows.length === 0 ? <p className="rb-hint">Meetings you start or join in this browser are listed here</p> : (
            <ul className="home-list">
              {rows.map((row) => (
                <li key={row.boardId}>
                  <span className="home-list-name">
                    <a className="rb-link" href={row.kind === 'hosted' ? recordLink(row.record, location.href) : row.joined.link}>{row.boardName}</a>
                    {row.kind === 'hosted' && row.record.state.rehearsal ? <Badge>Rehearsal</Badge> : null}
                    {row.kind === 'joined' ? <Badge>Joined</Badge> : null}
                  </span>
                  <span className="rb-hint">{rowStatus(row)}</span>
                  <span>
                    <Button variant="ghost" size="sm" aria-label={`Remove ${row.boardName}`}
                      onClick={(e) => { removeOpener.current = e.currentTarget; setRemoveError(''); setRemoving(row); }}>Remove</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {removeError ? <p className="rb-alert" role="alert">{removeError}</p> : null}
          <div>
            <label className="rb-btn rb-btn-secondary rb-file" aria-disabled={busy ? 'true' : undefined}>
              Open a meeting file
              <input type="file" className="rb-visually-hidden" accept=".json,application/json" disabled={busy}
                aria-describedby={fileError ? 'meeting-file-error' : undefined}
                onChange={(e) => void openFile(e.currentTarget)} />
            </label>
          </div>
          {fileError ? <p className="rb-alert" id="meeting-file-error" role="alert">{fileError}</p> : null}
          <p className="rb-hint">This browser can delete meetings you haven't opened for a while. Back up each meeting when it ends.</p>
        </section>
      </div>
      <ConfirmDialog open={removing !== null} title={removing ? removeTitle(removing) : ''} onCancel={() => setRemoving(null)}
        returnFocusTo={removeOpener.current} focusCancel body={<p>{removing ? removeBody(removing) : ''}</p>}
        actions={[{ label: 'Remove', variant: 'danger', onClick: () => { if (removing) void remove(removing); } }]} />
    </main>
  );
}
