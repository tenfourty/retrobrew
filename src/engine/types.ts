import type { MessageKey } from './messages';

export type ColumnId = 'ideas' | 'toDiscuss' | 'discussing' | 'discussed';
export type Role = 'owner' | 'facilitator' | 'guest';
export type Phase = 'topics' | 'discussion' | 'ended';

export const SOUND_IDS = ['chime', 'bell', 'woodblock', 'pips'] as const;
export type SoundId = (typeof SOUND_IDS)[number];

export const CHOICES = ['extend', 'none', 'end'] as const;
export type Choice = (typeof CHOICES)[number];

export interface Topic {
  topicId: number;
  text: string;
  column: ColumnId;
  position: number;
  authorId: string;
  // One entry per dot, so one person can appear several times.
  voters: string[];
}

export interface Attendee {
  id: string;
  name: string;
  role: Role;
}

// On the host's clock. endsAt = startedAt + minutes × minuteMs.
export interface Timer {
  topicId: number;
  startedAt: number;
  endsAt: number;
  round: number;
  minuteMs: number;
}

export interface Totals {
  extend: number;
  none: number;
  end: number;
}

// Who has voted, and the totals, but never who chose what.
export interface ContinueVote {
  topicId: number;
  round: number;
  voters: string[];
  totals: Totals;
}

export interface BoardState {
  boardId: string;
  boardName: string;
  phase: Phase;
  voteAllowance: number;
  showVotes: boolean;
  topicIdSeed: number;
  topics: Topic[];
  attendees: Record<string, Attendee>;
  timer: Timer | null;
  // The last round number used. It only ever goes up.
  voteRound: number;
  continueVote: ContinueVote | null;
  timerSound: SoundId;
  // Set at creation and never changed.
  rehearsal: boolean;
  endedAt: number | null;
  // topicIds in the order they were finished.
  discussedOrder: number[];
  // What "Move on" cleared when it decided an open time-up vote, so "Undo" can put it back. Never in a view.
  // Cleared when another topic starts or the meeting ends or goes back to topics.
  moveOnUndo?: MoveOnUndo | null;
}

export interface MoveOnUndo {
  topicId: number;
  timer: NonNullable<BoardState['timer']>;
  continueVote: ContinueVote;
}

// What one viewer is sent. It never holds anyone's voter IDs, the vote's
// voters list, voteRound or topicIdSeed (docs/product/sync-protocol.md, The views).
export interface TopicView {
  topicId: number;
  text: string;
  column: ColumnId;
  position: number;
  authorId: string;
  // The count, left out where the rules hide it.
  votes?: number;
  // The viewer's own dots.
  mine: number;
}

export interface Turnout {
  voted: number;
  here: number;
}

export interface VoteView {
  topicId: number;
  round: number;
  voted: boolean;
  turnout: Turnout;
  // For facilitators, and for viewers who have voted.
  totals?: Totals;
}

// The last refused command of one tab. key is a key of MESSAGES; a participant shows badCommand for a key it doesn't know.
export interface Reject {
  clientSeq: number;
  key: string;
}

export interface ViewState {
  boardId: string;
  boardName: string;
  phase: Phase;
  voteAllowance: number;
  showVotes: boolean;
  rehearsal: boolean;
  timerSound: SoundId;
  endedAt: number | null;
  discussedOrder: number[];
  topics: TopicView[];
  attendees: Record<string, Attendee>;
  online: string[];
  timer: Timer | null;
  vote: VoteView | null;
  role: Role;
  acks: Record<string, number>;
  rejects: Record<string, Reject>;
  joinRefused?: string;
}

// The viewer-neutral part of a view, the same for everyone.
export type SharedTopic = Omit<TopicView, 'mine'>;
export type SharedVote = Omit<VoteView, 'voted' | 'totals'>;
export type SharedView = Omit<ViewState, 'topics' | 'vote' | 'role' | 'acks' | 'rejects' | 'joinRefused'> & {
  topics: SharedTopic[];
  vote: SharedVote | null;
};

// What differs per viewer. mine is {topicId: dots} for topics the viewer has dots on.
export interface PersonalView {
  you: string;
  role: Role;
  mine: Record<string, number>;
  voted: boolean;
  totals?: Totals;
  acks: Record<string, number>;
  rejects: Record<string, Reject>;
  joinRefused?: string;
}

// What the session knows and the board doesn't: who is online, and the viewer's acks and rejects.
export interface ViewContext {
  online?: string[];
  acks?: Record<string, number>;
  rejects?: Record<string, Reject>;
  joinRefused?: string;
}

export type Command =
  | { type: 'join'; name: string }
  | { type: 'addTopic'; text: string }
  | { type: 'editTopic'; topicId: number; text: string }
  | { type: 'deleteTopic'; topicId: number }
  | { type: 'addVote'; topicId: number }
  | { type: 'removeVote'; topicId: number }
  | { type: 'raiseAllowance'; votes: number }
  | { type: 'clearVotes' }
  | { type: 'setShowVotes'; value: boolean }
  | { type: 'startDiscussion' }
  | { type: 'backToTopics' }
  | { type: 'endMeeting' }
  | { type: 'reopenMeeting' }
  | { type: 'discussTopic'; topicId: number; minutes: number; realMinutes?: boolean }
  | { type: 'stopTimer'; topicId: number }
  | { type: 'restartTimer'; topicId: number; minutes: number; realMinutes?: boolean }
  | { type: 'returnTopic'; topicId: number }
  | { type: 'finishTopic'; topicId: number }
  | { type: 'undoMoveOn'; topicId: number }
  // choice is any string here; the engine refuses an unknown one with badChoice.
  | { type: 'voteToContinue'; topicId: number; round: number; choice: string }
  | { type: 'extendTopic'; topicId: number; round: number; minutes: number }
  // sound is any string here; the engine refuses an unknown one with badSound.
  | { type: 'setTimerSound'; sound: string };

export type CommandOf<T extends Command['type']> = Extract<Command, { type: T }>;

// The refusal a growing change gets if the host measures it over the size cap.
export type SizeKey = 'boardFull' | 'meetingFullSize';

// changed is false when an accepted command leaves the board as it was, so its version (seq) stays put.
// grows marks a change that can take the board past the size cap: the host measures the new state
// before committing it, and refuses it with that key if it is too big.
export type Result =
  | { ok: true; state: BoardState; changed: boolean; grows?: SizeKey }
  | { ok: false; key: MessageKey; message: string };

export const TIMEBOX_MINUTES = [1, 2, 3, 4, 5, 10, 15, 20, 30] as const;
export const VOTE_ALLOWANCES = [3, 5, 8, 10] as const;
