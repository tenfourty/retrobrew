import type { BoardState, Topic } from './types';

const HOUR_MS = 60 * 60_000;
const REAL_MINUTE_MS = 60_000;

// What a board saved before the MVP may lack. Every field is checked at run time.
type SavedBoard = Omit<BoardState, 'phase' | 'voteRound' | 'continueVote' | 'timerSound' | 'rehearsal' | 'endedAt' | 'discussedOrder' | 'timer'>
  & Partial<Pick<BoardState, 'phase' | 'voteRound' | 'continueVote' | 'timerSound' | 'rehearsal' | 'endedAt' | 'discussedOrder'>>
  & { timer: (Omit<NonNullable<BoardState['timer']>, 'round' | 'minuteMs'> & { round?: number; minuteMs?: number }) | null };

const byOrder = (a: Topic, b: Topic) => a.position - b.position || a.topicId - b.topicId;

// Bring a saved board up to date on load. It never cuts or drops anything, and
// running it again on its own output changes nothing.
export function migrateBoard(saved: BoardState, now: number = Date.now()): BoardState {
  const old = structuredClone(saved) as SavedBoard;
  const topics = old.topics;
  let phase = old.phase ?? (topics.some((t) => t.column !== 'ideas') ? 'discussion' : 'topics');
  // The skeleton's Discuss button could leave a topic in Discussing during the topics phase:
  // such a board is in discussion.
  if (phase === 'topics' && topics.some((t) => t.column === 'toDiscuss' || t.column === 'discussing')) phase = 'discussion';
  if (phase === 'discussion') for (const t of topics) if (t.column === 'ideas') t.column = 'toDiscuss';
  let voteRound = old.voteRound ?? 0;
  let timer: BoardState['timer'] = null;
  if (old.timer) {
    const round = old.timer.round ?? (voteRound += 1);
    // Even a stale timer used its round, so the next one must not repeat it.
    voteRound = Math.max(voteRound, round);
    timer = { ...old.timer, round, minuteMs: old.timer.minuteMs ?? REAL_MINUTE_MS };
    if (now - timer.endsAt > HOUR_MS) timer = null;
  }
  let continueVote = old.continueVote ?? null;
  // A time-up vote exists only for the current timer.
  if (continueVote && (!timer || continueVote.round !== timer.round || continueVote.topicId !== timer.topicId)) continueVote = null;
  voteRound = Math.max(voteRound, continueVote?.round ?? 0);
  const discussedOrder = old.discussedOrder
    ?? topics.filter((t) => t.column === 'discussed').sort(byOrder).map((t) => t.topicId);
  return {
    ...old,
    phase,
    topics,
    timer,
    voteRound,
    continueVote,
    timerSound: old.timerSound ?? 'chime',
    rehearsal: old.rehearsal ?? false,
    endedAt: old.endedAt ?? null,
    discussedOrder,
  };
}
