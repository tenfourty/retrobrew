import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_RELAYS } from '../../config';
import { saveImportedBoard, type BoardRecord, type BoardStore } from '../../store/board-store';
import { Badge } from '../../ui/badge';
import { Button, ModeSwitch } from '../../ui/components';
import { boardIsHosted } from '../browser';
import { exclusive } from '../exclusive';
import { markJustCreated } from '../handoff';
import { createBoardRecord, recordLink } from '../host-controller';
import { getDeviceSigner, rememberName } from '../identity';
import { checkFileSize, meetingStatus, readMeetingFile } from '../meeting-file';
import { recordPersistence, storeNewMeeting } from '../persistence';

export const NAME_HINT = 'Everyone in the meeting sees this name next to the topics you add';

// The app home (docs/product/mvp-screens.md, The app home): start a meeting, or open one started in this browser.
// /app/#start focuses the form; /app/#start&rehearsal creates a rehearsal board.
export function Home({ store, start = false, rehearsal = false }: { store: BoardStore; start?: boolean; rehearsal?: boolean }) {
  const [boards, setBoards] = useState<BoardRecord[]>([]);
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
    void store.list().then((list) => setBoards(list.sort((a, b) => b.updatedAt - a.updatedAt)));
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
        </form>
        {guide('bottom')}
        <section className="app-panel" aria-labelledby="your-meetings">
          <h2 className="app-panel-title" id="your-meetings">Your meetings</h2>
          {boards.length === 0 ? <p className="rb-hint">Meetings you start in this browser are listed here</p> : (
            <ul className="home-list">
              {boards.map((b) => (
                <li key={b.boardId}>
                  <span className="home-list-name">
                    <a className="rb-link" href={recordLink(b, location.href)}>{b.state.boardName}</a>
                    {b.state.rehearsal ? <Badge>Rehearsal</Badge> : null}
                  </span>
                  <span className="rb-hint">{meetingStatus(b.state)}</span>
                </li>
              ))}
            </ul>
          )}
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
    </main>
  );
}
