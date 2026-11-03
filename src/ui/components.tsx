import { toChildArray, type ButtonHTMLAttributes, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { cx } from './cx';
import { capAtCaret, capTopic, charactersLeftText, COUNTER_FROM, formatClock, topicLength } from './format';
import { setMode, useMode, type Mode } from './mode';

// Native Preact port of design/system/components/bundle.js. Class names stay identical so bundle.css applies.
export type ColumnState = 'ideas' | 'todiscuss' | 'discussing' | 'discussed';
const STATE_LABEL: Record<ColumnState, string> = { ideas: 'Ideas', todiscuss: 'To discuss', discussing: 'Discussing', discussed: 'Discussed' };

export function ModeSwitch(props: { mode?: Mode; onChange?: (mode: Mode) => void; applyToPage?: boolean; className?: string }) {
  const live = useMode();
  const party = (props.mode ?? live) === 'party';
  return (
    <button type="button" role="switch" aria-checked={party ? 'true' : 'false'} aria-label="Party mode"
      className={cx('rb-switch', props.className)}
      onClick={() => {
        const next: Mode = party ? 'business' : 'party';
        props.onChange?.(next);
        if (props.applyToPage !== false) setMode(next);
      }}>
      <span className="rb-sw-biz">Business</span>
      <span className="rb-sw-party">Party</span>
    </button>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
}
export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return <button {...rest} type={type} className={cx('rb-btn', `rb-btn-${variant}`, size === 'sm' && 'rb-btn-sm', className as string)} />;
}

export function StateChip(props: { state?: ColumnState; count?: number; children?: ComponentChildren; className?: string }) {
  const state = props.state ?? 'ideas';
  return (
    <span className={cx('rb-chip', `rb-st-${state}`, props.className)}>
      {props.children ?? STATE_LABEL[state]}
      {props.count != null ? <span className="rb-chip-count">{props.count}</span> : null}
    </span>
  );
}

// `count` is the number on the chip (the topics shown if left out); `null` shows no number. `focusable` lets code move focus to
// the column; `focusFallback` also makes it the place focus lands when a sheet's opener has gone (see Sheet).
export function Column(props: { focusable?: boolean; focusFallback?: boolean; state?: ColumnState; title?: string; count?: number | null; note?: ComponentChildren; action?: ComponentChildren; empty?: ComponentChildren; children?: ComponentChildren; className?: string }) {
  const state = props.state ?? 'ideas';
  const kids = toChildArray(props.children);
  return (
    <section className={cx('rb-col', `rb-st-${state}`, props.className)} aria-label={props.title ?? STATE_LABEL[state]} tabIndex={props.focusable || props.focusFallback ? -1 : undefined}
      data-focus-fallback={props.focusFallback ? '' : undefined}>
      <header className="rb-col-head">
        <StateChip state={state} count={props.count === null ? undefined : props.count ?? kids.length}>{props.title}</StateChip>
        {props.action ?? null}
      </header>
      {props.note ? <p className="rb-col-note">{props.note}</p> : null}
      {kids.length ? kids : <div className="rb-col-empty">{props.empty ?? 'Nothing here yet'}</div>}
    </section>
  );
}

// A sub-heading inside a column, such as "No votes yet" at the end of To discuss (design/system/components/Column).
export function ColumnGroup(props: { children: ComponentChildren }) {
  return <h2 className="rb-col-group">{props.children}</h2>;
}

// With `hidden` (Show votes off, before the discussion) the count is unknown: only the viewer's own dots show, with
// "Votes hidden" in place of the count.
export function VoteDots(props: { count: number; mine?: number; max?: number; fresh?: boolean; showCount?: boolean; hidden?: boolean }) {
  const mine = props.mine ?? 0;
  if (props.hidden) {
    return (
      <span className="rb-dots" role="img" aria-label={`Votes hidden${mine ? `, ${mine} yours` : ''}`}>
        {Array.from({ length: Math.min(mine, props.max ?? 6) }, (_, i) => <span key={i} className="rb-dot rb-dot-mine" />)}
        <span className="rb-dots-hidden" aria-hidden="true">Votes hidden</span>
      </span>
    );
  }
  const n = props.count || 0;
  const shown = Math.min(n, props.max ?? 6);
  const label = `${n} ${n === 1 ? 'vote' : 'votes'}${mine ? `, ${mine} yours` : ''}`;
  return (
    <span className="rb-dots" role="img" aria-label={label}>
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className={cx('rb-dot', i < mine && 'rb-dot-mine', props.fresh && i === shown - 1 && 'rb-dot-new')} />
      ))}
      {n > shown || props.showCount ? <span className="rb-dots-count">{n}</span> : null}
    </span>
  );
}

// "3 votes left", "1 vote left" or "No votes left". The dots are decoration; the words carry the count.
export function votesLeftText(left: number): string {
  if (left <= 0) return 'No votes left';
  return left === 1 ? '1 vote left' : `${left} votes left`;
}

export function VoteBudget(props: { total?: number; used?: number }) {
  const total = props.total ?? 3;
  const used = props.used ?? 0;
  return (
    <span className="rb-budget">
      <span>{votesLeftText(total - used)}</span>
      <span className="rb-dots" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => <span key={i} className={cx('rb-dot', i >= total - used && 'rb-dot-spent')} />)}
      </span>
    </span>
  );
}

export interface TopicEditing {
  label: string;
  value: string;
  onInput: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export interface TopicCardProps {
  text: string; author?: string; number?: number; votes?: number; mine?: number; fresh?: boolean; state?: ColumnState;
  live?: boolean; votesHidden?: boolean; actions?: ComponentChildren; editing?: TopicEditing; alert?: string;
  children?: ComponentChildren; className?: string;
}
// Focuses the edit field once, when it appears (the autofocus attribute is ignored on an element added after load).
function focusOnMount(input: HTMLInputElement | null): void {
  if (input && !input.dataset.focused) { input.dataset.focused = '1'; input.focus(); }
}

function takeEdit(editing: TopicEditing, input: HTMLInputElement): void {
  const { text, caret } = capAtCaret(editing.value, input.value, input.selectionStart ?? input.value.length);
  if (text !== input.value) {
    input.value = text;
    input.setSelectionRange(caret, caret);
  }
  editing.onInput(text);
}

// A topic (design/system/components/TopicCard). `actions` is its row of small buttons; `editing` turns its text into a
// field with Save and Cancel (Enter saves, Escape cancels); `alert` is a refusal from the last action on it.
export function TopicCard(props: TopicCardProps) {
  const state = props.state ?? 'ideas';
  const editing = props.editing;
  return (
    <article className={cx('rb-card', `rb-st-${state}`, props.live && 'rb-card-live', props.className)} data-card={props.number}>
      {editing ? (
        <form className="rb-card-edit" onSubmit={(e) => { e.preventDefault(); editing.onSave(); }}>
          <label className="rb-visually-hidden" htmlFor={`edit-${props.number}`}>{editing.label}</label>
          <input id={`edit-${props.number}`} className="rb-input" value={editing.value} ref={focusOnMount}
            // Cut only what overflowed from the inserted text, as the add box does, and not mid-composition.
            onInput={(e) => (e as InputEvent).isComposing ? editing.onInput(e.currentTarget.value) : takeEdit(editing, e.currentTarget)}
            onCompositionEnd={(e) => takeEdit(editing, e.currentTarget)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing.onCancel(); } }} />
          <div className="rb-card-actions">
            <Button type="submit" size="sm" variant="primary">Save</Button>
            <Button size="sm" variant="ghost" onClick={editing.onCancel}>Cancel</Button>
          </div>
        </form>
      ) : <p className="rb-card-text">{props.text}</p>}
      {props.children ?? null}
      <div className="rb-card-foot">
        <span>
          {props.author ?? ''}
          {props.number != null ? <span className="rb-card-num">{` · #${props.number}`}</span> : null}
        </span>
        <span className="rb-dots">
          {props.votesHidden ? <VoteDots count={0} mine={props.mine} hidden /> : null}
          {!props.votesHidden && props.votes != null ? <VoteDots count={props.votes} mine={props.mine} fresh={props.fresh} /> : null}
        </span>
      </div>
      {props.alert ? <p className="rb-card-alert">{props.alert}</p> : null}
      {props.actions && !editing ? <div className="rb-card-actions">{props.actions}</div> : null}
    </article>
  );
}

// m:ss in both modes, "Time's up" once `up` says the vote is open (by default, at zero).
export function dialReading(remaining: number, up: boolean): string {
  return up ? "Time's up" : formatClock(Math.max(0, remaining));
}

// warnAt is one timebox minute in seconds (60, or 10 on a rehearsal timer). The dial has no live region of its own: the
// page's single polite live region announces the countdown.
export function DialTimer(props: { remaining: number; total: number; warnAt?: number; up?: boolean; sub?: string; className?: string }) {
  const total = props.total || 300;
  const remaining = props.remaining;
  // `up` is the time-up vote being open; without it the dial reads 0:00 at zero, as the status strip does.
  const up = props.up ?? remaining <= 0;
  const warn = !up && remaining <= (props.warnAt ?? 60);
  const p = up ? 1 : Math.max(0, Math.min(1, remaining / total));
  return (
    <div className={cx('rb-timer', warn && 'rb-timer-warn', up && 'rb-timer-up', props.className)} role="timer">
      <div className="rb-dial" style={`--p:${p}`} aria-hidden="true" />
      <div>
        <span className="rb-timer-num">{dialReading(remaining, up)}</span>
        {props.sub ? <span className="rb-timer-sub">{props.sub}</span> : null}
      </div>
    </div>
  );
}

export interface TopicInputProps {
  onAdd?: (text: string) => void; value?: string; onValueChange?: (text: string) => void; onFocus?: () => void; onBlur?: () => void;
  placeholder?: string; cta?: string; hint?: string; id?: string; className?: string; disabled?: boolean;
}
// Enter submits and keeps focus here. Pass value and onValueChange to control it, so the page knows about a draft.
export function TopicInput(props: TopicInputProps) {
  const [own, setOwn] = useState('');
  const value = props.value ?? own;
  const id = props.id ?? 'rb-topic';
  const set = (next: string) => {
    props.onValueChange?.(next);
    if (props.value === undefined) setOwn(next);
  };
  const length = topicLength(value);
  const counted = length >= COUNTER_FROM;
  const describedBy = [counted ? `${id}-count` : '', props.hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  // Cut only what overflowed from the inserted text, and put the caret where the insertion ended.
  const take = (input: HTMLInputElement) => {
    const { text, caret } = capAtCaret(value, input.value, input.selectionStart ?? input.value.length);
    if (text !== input.value) {
      input.value = text;
      input.setSelectionRange(caret, caret);
    }
    set(text);
  };
  return (
    <form className={cx('rb-add', props.className)} onSubmit={(e) => {
      e.preventDefault();
      const text = value.trim();
      if (!text) return;
      props.onAdd?.(text);
      set('');
    }}>
      <label htmlFor={id} className="rb-visually-hidden">New topic</label>
      {/* Preact's onChange fires on blur; onInput tracks every keystroke. */}
      <input id={id} className="rb-input" value={value} placeholder={props.placeholder ?? 'Add a topic'} enterKeyHint="send"
        disabled={props.disabled} aria-describedby={describedBy}
        // Not mid-composition: an IME's pending text is cut when the composition ends.
        onInput={(e) => (e as InputEvent).isComposing ? set(e.currentTarget.value) : take(e.currentTarget)}
        onCompositionEnd={(e) => take(e.currentTarget)}
        onFocus={props.onFocus} onBlur={props.onBlur} />
      {/* Tapping the button keeps focus in the field, as Enter does, so a phone keeps its keyboard and nothing moves under the tap. */}
      <Button type="submit" variant="primary" disabled={props.disabled} onMouseDown={(e) => e.preventDefault()}>{props.cta ?? 'Add topic'}</Button>
      {counted ? <p className="rb-add-count" id={`${id}-count`}>{charactersLeftText(length)}</p> : null}
      {props.hint ? <p className="rb-add-hint" id={`${id}-hint`}>{props.hint}</p> : null}
    </form>
  );
}

export function AttendeeChip(props: { name: string; role?: string; online?: boolean; handRaised?: boolean; queue?: number; className?: string }) {
  const initials = (props.name || '?').split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
  return (
    <span className={cx('rb-person', props.className)}>
      <span className="rb-avatar" data-presence={props.online ? 'online' : 'away'} aria-hidden="true">{initials}</span>
      <span>
        <span className="rb-person-name">{props.name}</span>
        {props.role ? <span className="rb-person-role">{` · ${props.role}`}</span> : null}
      </span>
      {props.handRaised ? <span className="rb-hand">{`Hand up${props.queue ? ` · ${props.queue}` : ''}`}</span> : null}
    </span>
  );
}
