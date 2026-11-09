import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildReport } from '../../feedback/collect';
import { COPY } from '../../feedback/copy';
import { personText, type BuildVersion, type ReportInputs } from '../../feedback/inputs';
import { reportRows } from '../../feedback/rows';
import type { FeedbackKind } from '../../feedback/schema';
import { sendFeedback, type SendFailure } from '../../feedback/send';
import {
  canSend, clearDraft, countAnnouncement, countText, emailState, failureLine, getDraft, initialKind, messageState, pasteOverflows, setDraft,
  troubleLine,
} from '../../feedback/sheet-model';
import type { Trouble } from '../../feedback/trouble';
import { Button } from '../../ui/components';
import { ReportList } from '../../ui/report-list';
import { Segmented } from '../../ui/segmented';
import { Sheet } from '../../ui/sheet';
import { copyText } from '../clipboard';
import { feedbackEnabled } from '../feedback-gate';

/** What the app hands the sheet: everything in a report except what the person writes here. */
export type SheetInputs = Omit<ReportInputs, 'kind' | 'message' | 'email'>;

export interface FeedbackSheetProps {
  open: boolean;
  onClose: () => void;
  /** Reads the report's signals, once, as the sheet opens. The app builds it from named signals only (`feedbackInputs()`). */
  prepare: () => SheetInputs;
  /** Asks the site which build it serves now, once, as the sheet opens; the answer joins the report when it arrives (null: unknown). */
  loadLiveVersion?: () => Promise<BuildVersion | null>;
  /** The trouble the app has noticed, if any: the sheet opens with a line saying why and "Something broke" chosen. */
  trouble?: Trouble | null;
  /** Called after the feedback is sent, so the app can clear its `error` trouble. */
  onSent?: () => void;
  returnFocusTo?: HTMLElement | null;
}

const KIND_OPTIONS = /* @__PURE__ */ (['broke', 'idea', 'other'] as const).map((value) => ({ value, label: COPY.kinds[value] }));

// The sheet exists only in a build that carries the feature, on the origin it was built for (src/app/feedback-gate.ts).
export function FeedbackSheet(props: FeedbackSheetProps) {
  if (!props.open || !feedbackEnabled()) return null;
  return <OpenFeedbackSheet {...props} />;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

function growToFit(input: HTMLTextAreaElement | null): void {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 8 * 24)}px`;
}

function OpenFeedbackSheet({ onClose, prepare, loadLiveVersion, trouble = null, onSent, returnFocusTo }: FeedbackSheetProps) {
  const saved = getDraft();
  const [kind, setKind] = useState<FeedbackKind>(saved.kind ?? initialKind(trouble));
  const [message, setMessage] = useState(saved.message);
  const [email, setEmail] = useState(saved.email);
  const [emailLeft, setEmailLeft] = useState(false);
  const [cut, setCut] = useState(false);
  const [phase, setPhase] = useState<'editing' | 'sending' | 'sent'>('editing');
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [copiedAs, setCopiedAs] = useState<string | null>(null);
  const online = useOnline();
  const area = useRef<HTMLTextAreaElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  // The report's signals are read once, as the sheet opens, so the rows do not shift while the person types.
  const prepared = useMemo(prepare, []);
  const [liveVersion, setLiveVersion] = useState<BuildVersion | null>(null);
  const inputs = { ...prepared, liveVersion };

  useEffect(() => { growToFit(area.current); }, []);
  useEffect(() => {
    let current = true;
    void loadLiveVersion?.().then((version) => { if (current) setLiveVersion(version); });
    return () => { current = false; };
  }, []);
  useEffect(() => { if (phase === 'sent') done.current?.focus(); }, [phase]);

  const remember = (next: { kind?: FeedbackKind; message?: string; email?: string }) =>
    setDraft({ kind: next.kind ?? kind, message: next.message ?? message, email: next.email ?? email });

  const text = messageState(message);
  const emailCheck = emailState(email);
  const real = buildReport({ ...inputs, kind, message: personText(message), email: email.trim() ? personText(email) : null });
  // While nothing can be sent yet, the preview shows what would be, with a stand-in for the message.
  const preview = real.ok ? real : buildReport({ ...inputs, kind, message: personText(COPY.messageStandIn), email: null });
  const mayTry = canSend({ empty: text.empty, link: text.link, email: emailCheck, sending: phase === 'sending', online }) && real.ok;

  const send = async (event?: Event) => {
    event?.preventDefault();
    setEmailLeft(true);
    if (!mayTry || !real.ok) return;
    setPhase('sending');
    setFailure(null);
    const result = await sendFeedback(real.json);
    if (result.ok) {
      clearDraft();
      setPhase('sent');
      onSent?.();
    } else {
      setPhase('editing');
      setFailure(result.reason);
    }
  };

  const copy = async (what: string, label: string) => {
    if (await copyText(what)) setCopiedAs(label);
  };

  if (phase === 'sent') {
    return (
      <Sheet open title={COPY.title} onClose={onClose} noClose returnFocusTo={returnFocusTo}>
        <div role="status" className="fbk-sent">
          <p>{COPY.sent}</p>
          {real.ok && real.body.contact ? <p>{COPY.sentEmail}</p> : null}
        </div>
        <div className="rb-confirm-actions">
          <Button variant="primary" ref={done} onClick={onClose}>{COPY.done}</Button>
        </div>
      </Sheet>
    );
  }

  const count = countText(text.left);
  const showEmailError = emailCheck === 'invalid' && emailLeft;
  return (
    <Sheet open title={COPY.title} onClose={onClose} noClose className="fbk-sheet" returnFocusTo={returnFocusTo}>
      <form className="fbk-form" onSubmit={send} noValidate>
        {trouble ? <p className="rb-hint fbk-trouble">{troubleLine(trouble.source)}</p> : null}
        <Segmented label={COPY.kindLabel} options={KIND_OPTIONS} value={kind} onChange={(value) => { setKind(value); remember({ kind: value }); }} />
        <div className="rb-field">
          <label className="rb-label" htmlFor="fbk-message">{COPY.messageLabel}</label>
          <textarea id="fbk-message" ref={area} className="rb-input fbk-message" rows={4} maxLength={2000} value={message}
            aria-invalid={text.link ? 'true' : undefined} aria-describedby={`fbk-message-hint${text.link ? ' fbk-link-alert' : ''}`}
            onPaste={(e) => {
              const target = e.currentTarget;
              setCut(pasteOverflows(target.value, target.selectionStart, target.selectionEnd, e.clipboardData?.getData('text') ?? ''));
            }}
            onInput={(e) => {
              setCut(false);
              setMessage(e.currentTarget.value);
              remember({ message: e.currentTarget.value });
              growToFit(e.currentTarget);
            }} />
          <p className="rb-hint" id="fbk-message-hint">{COPY.messageHint}</p>
          {count ? <p className={`rb-hint fbk-count${text.left <= 0 ? ' fbk-count-full' : ''}`} aria-hidden="true">{count}</p> : null}
          <span className="rb-visually-hidden" role="status" aria-live="polite">{countAnnouncement(text.left)}</span>
          {cut ? <p className="rb-alert">{COPY.cutNotice}</p> : null}
          {text.link ? <p className="rb-alert" id="fbk-link-alert" role="alert">{COPY.linkRefused}</p> : null}
        </div>
        <details className="fbk-report" open={trouble != null}>
          <summary>{COPY.reportSummary}</summary>
          {preview.ok ? (
            <>
              {preview.reportFailed ? <p className="rb-hint">{COPY.noReport}</p> : null}
              <ReportList rows={reportRows(preview.body)} json={preview.json} jsonSummary={COPY.jsonSummary} jsonLabel={COPY.jsonLabel}
                copyLabel={copiedAs === 'json' ? COPY.copied : COPY.copyJson} onCopy={() => copy(preview.json, 'json')} />
            </>
          ) : null}
        </details>
        <div className="rb-field">
          <label className="rb-label" htmlFor="fbk-email">{COPY.emailLabel}</label>
          <input id="fbk-email" type="email" className="rb-input" autoComplete="email" inputMode="email" maxLength={254} value={email}
            aria-invalid={showEmailError ? 'true' : undefined} aria-describedby={`fbk-email-hint${showEmailError ? ' fbk-email-alert' : ''}`}
            onBlur={() => setEmailLeft(true)} onInput={(e) => { setEmail(e.currentTarget.value); remember({ email: e.currentTarget.value }); }} />
          <p className="rb-hint" id="fbk-email-hint">{COPY.emailHint}</p>
          {showEmailError ? <p className="rb-alert" id="fbk-email-alert" role="alert">{COPY.emailInvalid}</p> : null}
        </div>
        <p className="fbk-consent">
          {COPY.consent} <a href={COPY.consentHref} target="_blank" rel="noopener">{COPY.consentLink}</a>
        </p>
        {phase === 'sending' ? <p className="rb-hint" role="status">{COPY.sendingStatus}</p> : null}
        {!online ? <p className="rb-alert" role="alert">{COPY.offline}</p> : null}
        {failure ? (
          <div className="fbk-failed">
            <p className="rb-alert" role="alert">{failureLine(failure)}</p>
            <Button variant="ghost" size="sm" onClick={() => copy(message, 'message')}>{copiedAs === 'message' ? COPY.copied : COPY.copyMessage}</Button>
          </div>
        ) : null}
        <div className="rb-confirm-actions">
          <Button type="submit" variant="primary" disabled={!mayTry}>{phase === 'sending' ? COPY.sending : COPY.send}</Button>
          <Button variant="ghost" onClick={onClose}>{COPY.cancel}</Button>
        </div>
      </form>
    </Sheet>
  );
}
