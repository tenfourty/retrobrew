import type * as React from 'react';
export type Mode = 'business' | 'party';
export type ColumnState = 'ideas' | 'todiscuss' | 'discussing' | 'discussed';

/** Business/Party toggle. Uncontrolled by default: flips the page's data-theme prefix and keeps light/dark. */
export interface ModeSwitchProps { mode?: Mode; onChange?: (mode: Mode) => void; applyToPage?: boolean; className?: string }
export declare function ModeSwitch(props: ModeSwitchProps): React.ReactElement;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'md' | 'sm' }
export declare function Button(props: ButtonProps): React.ReactElement;

/** Column heading mark. Label defaults to the product docs' column name. */
export interface StateChipProps { state?: ColumnState; count?: number; children?: React.ReactNode; className?: string }
export declare function StateChip(props: StateChipProps): React.ReactElement;

/** note is a line under the heading, such as "Votes are hidden until the discussion starts". */
export interface ColumnProps { state?: ColumnState; title?: string; count?: number | null; note?: React.ReactNode; action?: React.ReactNode; empty?: React.ReactNode; children?: React.ReactNode; className?: string }
export declare function Column(props: ColumnProps): React.ReactElement;

/** text is 1 to 280 characters. votes is left out where the rules hide the count. */
export interface TopicEditing { label: string; value: string; onInput: (value: string) => void; onSave: () => void; onCancel: () => void }
export interface TopicCardProps { text: string; author?: string; number?: number; votes?: number; mine?: number; fresh?: boolean; state?: ColumnState; live?: boolean; votesHidden?: boolean; actions?: React.ReactNode; editing?: TopicEditing; alert?: string; children?: React.ReactNode; className?: string }
export declare function TopicCard(props: TopicCardProps): React.ReactElement;

/** hidden: the count is unknown (Show votes off, before the discussion), so only the viewer's own dots show, with "Votes hidden". */
export interface VoteDotsProps { count: number; mine?: number; max?: number; fresh?: boolean; showCount?: boolean; hidden?: boolean }
export declare function VoteDots(props: VoteDotsProps): React.ReactElement;

/** Reads "{n} votes left", "1 vote left" or "No votes left". */
export interface VoteBudgetProps { total?: number; used?: number }
export declare function VoteBudget(props: VoteBudgetProps): React.ReactElement;

/** remaining, total and warnAt in seconds. Shows m:ss in both modes, warns from warnAt (one timebox minute, default 60),
 *  shows time up at 0, and has no live region of its own. sub is written by the caller, such as "of 5 min" or "of 50 s". */
export interface DialTimerProps { remaining: number; total: number; warnAt?: number; sub?: string; className?: string }
export declare function DialTimer(props: DialTimerProps): React.ReactElement;

export type TimeUpChoice = 'extend' | 'none' | 'end';
/** The time-up ballot: Keep going, No preference, Move on. totals and turnout show after voting (always for the
 *  facilitator); children hold the facilitator's decision area. */
export interface TimeUpVoteProps { topic: string; choice?: TimeUpChoice; voted: boolean; disabled?: boolean; onChoose?: (c: TimeUpChoice) => void; hint?: string; totals?: { extend: number; none: number; end: number }; turnout?: string; title?: string; children?: React.ReactNode; className?: string }
export declare function TimeUpVote(props: TimeUpVoteProps): React.ReactElement;

/** Up to 280 characters on one line, with a "{n} characters left" counter from 240. Pass value and onValueChange to control it. */
export interface TopicInputProps { onAdd?: (text: string) => void; value?: string; onValueChange?: (text: string) => void; onFocus?: () => void; onBlur?: () => void; placeholder?: string; cta?: string; hint?: string; id?: string; className?: string }
export declare function TopicInput(props: TopicInputProps): React.ReactElement;

export interface AttendeeChipProps { name: string; role?: string; online?: boolean; handRaised?: boolean; queue?: number; className?: string }
export declare function AttendeeChip(props: AttendeeChipProps): React.ReactElement;

/** A small label beside a name, such as "Rehearsal". */
export interface BadgeProps { children?: React.ReactNode; className?: string }
export declare function Badge(props: BadgeProps): React.ReactElement;

/** A bottom sheet on phones and a centred dialog on wide screens: a native modal dialog with a title, a focus trap,
 *  Escape to close, and a Close button unless noClose. Focus goes back to the control that opened it. */
export interface SheetProps { open: boolean; title: string; onClose: () => void; noClose?: boolean; initialFocus?: string; children?: React.ReactNode; className?: string }
export declare function Sheet(props: SheetProps): React.ReactElement | null;

export interface ConfirmAction { label: string; variant: 'primary' | 'secondary' | 'danger'; onClick: () => void }
/** A Sheet with a body and a button row: other actions first, the danger action last but one, Cancel last. */
export interface ConfirmDialogProps { open: boolean; title: string; body: React.ReactNode; actions: ConfirmAction[]; onCancel: () => void; cancelLabel?: string }
export declare function ConfirmDialog(props: ConfirmDialogProps): React.ReactElement | null;

/** A light, high-contrast ground for a QR code in every theme. */
export interface QrPanelProps { children?: React.ReactNode; className?: string }
export declare function QrPanel(props: QrPanelProps): React.ReactElement;

/** A full-width message across the top of the board. One at a time; the highest priority wins. */
export interface BannerProps { tone?: 'info' | 'warning' | 'error'; action?: { label: string; onClick: () => void }; children?: React.ReactNode; className?: string }
export declare function Banner(props: BannerProps): React.ReactElement;

/** An on/off control with a label and an optional hint, as role="switch". */
export interface SwitchProps { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string | string[]; disabled?: boolean }
export declare function Switch(props: SwitchProps): React.ReactElement;

export interface SegmentOption<T> { value: T; label: string; disabled?: boolean }
/** A single choice from a row of buttons, wrapping onto more rows on phones: timeboxes, extensions, the vote allowance. */
export interface SegmentedProps<T> { label: string; options: SegmentOption<T>[]; value: T; onChange: (value: T) => void; hint?: string }
export declare function Segmented<T extends string | number>(props: SegmentedProps<T>): React.ReactElement;

/** A short-lived line saying how a time-up vote was decided. No live region of its own. */
export interface OutcomeLineProps { children?: React.ReactNode; className?: string }
export declare function OutcomeLine(props: OutcomeLineProps): React.ReactElement;

/** The facilitator's next step: a phone bar (primary last, so on the right, and at most one other) or a stacked block. */
export interface ActionBarProps { stacked: boolean; label: string; children?: React.ReactNode; className?: string }
export declare function ActionBar(props: ActionBarProps): React.ReactElement;

export interface ListAction { label: string; onClick: () => void; variant?: ButtonProps['variant']; disabled?: boolean }
/** Full-width buttons, one per row, for the phone's "More" sheet. */
export interface ActionListProps { actions: ListAction[] }
export declare function ActionList(props: ActionListProps): React.ReactElement;

/** A sub-heading inside a column, such as "No votes yet" at the end of To discuss. */
export interface ColumnGroupProps { children?: React.ReactNode }
export declare function ColumnGroup(props: ColumnGroupProps): React.ReactElement;

export interface TabItem<T extends string> { id: T; label: string; count?: number; state?: ColumnState }
/** An accessible tab list with counts. Each tab controls the element with id `${base}-panel-${id}`. */
export interface TabsProps<T extends string> { label: string; base: string; tabs: TabItem<T>[]; selected: T; onSelect: (id: T) => void }
export declare function Tabs<T extends string>(props: TabsProps<T>): React.ReactElement;

/** The phone's one-line strip: the topic in Discussing, the start of its text, its time, and the Vote chip. */
export interface StatusStripProps { label: string; idleText?: string; number?: number; text?: string; end?: string; chip: boolean; up?: boolean; onOpen: () => void; onChip: (opener: HTMLElement) => void }
export declare function StatusStrip(props: StatusStripProps): React.ReactElement;

/** The ended board as one list in two parts: "Discussed", numbered, then "Not discussed" (left out when empty). */
export interface EndedSummaryProps { discussed: React.ReactNode[]; notDiscussed: React.ReactNode[] }
export declare function EndedSummary(props: EndedSummaryProps): React.ReactElement;

/** A native select styled like .rb-input, with its label above: the timer sound. */
export interface SelectProps<T extends string> { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; disabled?: boolean }
export declare function Select<T extends string>(props: SelectProps<T>): React.ReactElement;

export declare function setMode(mode: Mode): void;
export declare function getMode(): Mode;
export declare function useMode(): Mode;

declare global { interface Window { Retrobrew: {
  ModeSwitch: typeof ModeSwitch; Button: typeof Button; StateChip: typeof StateChip; Column: typeof Column; TopicCard: typeof TopicCard;
  VoteDots: typeof VoteDots; VoteBudget: typeof VoteBudget; DialTimer: typeof DialTimer; TimeUpVote: typeof TimeUpVote; TopicInput: typeof TopicInput;
  AttendeeChip: typeof AttendeeChip; Badge: typeof Badge; Sheet: typeof Sheet; ConfirmDialog: typeof ConfirmDialog; QrPanel: typeof QrPanel; Banner: typeof Banner; Switch: typeof Switch; Segmented: typeof Segmented; OutcomeLine: typeof OutcomeLine; ActionBar: typeof ActionBar; ActionList: typeof ActionList; ColumnGroup: typeof ColumnGroup; Tabs: typeof Tabs; StatusStrip: typeof StatusStrip; EndedSummary: typeof EndedSummary; Select: typeof Select; setMode: typeof setMode; getMode: typeof getMode; useMode: typeof useMode } } }
