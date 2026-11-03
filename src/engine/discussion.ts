import { changed, refuse } from './result';
import { CHOICES, SOUND_IDS, TIMEBOX_MINUTES, type BoardState, type CommandOf, type Result, type Topic } from './types';

export const REAL_MINUTE_MS = 60_000;
// On a rehearsal board one timebox "minute" lasts 10 seconds.
export const REHEARSAL_MINUTE_MS = 10_000;

export function minuteMs(state: BoardState, realMinutes = false): number {
  return state.rehearsal && !realMinutes ? REHEARSAL_MINUTE_MS : REAL_MINUTE_MS;
}

// How long a timebox of this many minutes runs on this board.
export function timeboxMs(state: BoardState, minutes: number, realMinutes = false): number {
  return minutes * minuteMs(state, realMinutes);
}

const isTimebox = (minutes: number) => (TIMEBOX_MINUTES as readonly number[]).includes(minutes);

function discussing(state: BoardState): Topic | undefined {
  return state.topics.find((t) => t.column === 'discussing');
}

// Every new timer takes the next round, so a ballot for an old timer can never count towards a new vote.
// It always closes any time-up vote.
function startTimer(next: BoardState, topicId: number, minutes: number, realMinutes: boolean | undefined, now: number): void {
  next.voteRound += 1;
  next.timer = {
    topicId, startedAt: now, endsAt: now + timeboxMs(next, minutes, realMinutes), round: next.voteRound, minuteMs: minuteMs(next, realMinutes),
  };
  next.continueVote = null;
}

export function discussTopic(state: BoardState, cmd: CommandOf<'discussTopic'>, now: number): Result {
  if (state.phase !== 'discussion') return refuse('notDiscussion');
  if (!isTimebox(cmd.minutes)) return refuse('badTimebox');
  const topic = state.topics.find((t) => t.topicId === cmd.topicId);
  if (!topic) return refuse('noSuchTopic');
  if (topic.column !== 'toDiscuss') return refuse('notInToDiscuss');
  if (discussing(state)) return refuse('oneAtATime');
  const next = structuredClone(state);
  next.topics.find((t) => t.topicId === cmd.topicId)!.column = 'discussing';
  startTimer(next, cmd.topicId, cmd.minutes, cmd.realMinutes, now);
  return changed(next);
}

export function stopTimer(state: BoardState, cmd: CommandOf<'stopTimer'>): Result {
  if (discussing(state)?.topicId !== cmd.topicId) return refuse('notBeingDiscussed');
  if (!state.timer) return refuse('noTimer');
  return changed({ ...structuredClone(state), timer: null, continueVote: null });
}

// A fresh timebox whether the topic was timed, untimed or out of time.
export function restartTimer(state: BoardState, cmd: CommandOf<'restartTimer'>, now: number): Result {
  if (discussing(state)?.topicId !== cmd.topicId) return refuse('notBeingDiscussed');
  if (!isTimebox(cmd.minutes)) return refuse('badTimebox');
  const next = structuredClone(state);
  startTimer(next, cmd.topicId, cmd.minutes, cmd.realMinutes, now);
  return changed(next);
}

// Back to To discuss with its dots, so it can be picked again later.
export function returnTopic(state: BoardState, cmd: CommandOf<'returnTopic'>): Result {
  if (discussing(state)?.topicId !== cmd.topicId) return refuse('notBeingDiscussed');
  const next = structuredClone(state);
  next.topics.find((t) => t.topicId === cmd.topicId)!.column = 'toDiscuss';
  next.timer = null;
  next.continueVote = null;
  return changed(next);
}

// Allowed at any time while the topic is in Discussing, not only after time up.
export function finishTopic(state: BoardState, cmd: CommandOf<'finishTopic'>): Result {
  if (discussing(state)?.topicId !== cmd.topicId) return refuse('notBeingDiscussed');
  const next = structuredClone(state);
  next.topics.find((t) => t.topicId === cmd.topicId)!.column = 'discussed';
  next.discussedOrder.push(cmd.topicId);
  next.timer = null;
  next.continueVote = null;
  return changed(next);
}

export function setTimerSound(state: BoardState, cmd: CommandOf<'setTimerSound'>): Result {
  const sound = SOUND_IDS.find((id) => id === cmd.sound);
  if (!sound) return refuse('badSound');
  return changed({ ...structuredClone(state), timerSound: sound });
}

const EXTENSION_MINUTES = [1, 2, 3, 4, 5];

function voteOpenFor(state: BoardState, topicId: number, round: number): boolean {
  const vote = state.continueVote;
  return vote !== null && vote.topicId === topicId && vote.round === round;
}

// One ballot per person per round, never changed. Only who voted and the totals are kept, never who chose what.
export function voteToContinue(state: BoardState, actor: string, cmd: CommandOf<'voteToContinue'>): Result {
  if (!voteOpenFor(state, cmd.topicId, cmd.round)) return refuse('voteClosed');
  const choice = CHOICES.find((c) => c === cmd.choice);
  if (!choice) return refuse('badChoice');
  if (state.continueVote!.voters.includes(actor)) return refuse('alreadyVoted');
  const next = structuredClone(state);
  next.continueVote!.voters.push(actor);
  next.continueVote!.totals[choice] += 1;
  return changed(next);
}

// Keep going: a fresh timer with the next round, using the same minute length as the timer it replaces.
export function extendTopic(state: BoardState, cmd: CommandOf<'extendTopic'>, now: number): Result {
  if (!voteOpenFor(state, cmd.topicId, cmd.round)) return refuse('voteClosed');
  if (!EXTENSION_MINUTES.includes(cmd.minutes)) return refuse('badExtension');
  const next = structuredClone(state);
  startTimer(next, cmd.topicId, cmd.minutes, state.timer?.minuteMs === REAL_MINUTE_MS, now);
  return changed(next);
}

// Time up is a host tick, not a command. Returns the board with the time-up vote open,
// or null when there is nothing to do: no timer, not yet out of time, or its vote already open.
export function openTimeUpVote(state: BoardState, now: number): BoardState | null {
  const timer = state.timer;
  if (!timer || now < timer.endsAt || state.continueVote?.round === timer.round) return null;
  const next = structuredClone(state);
  next.continueVote = { topicId: timer.topicId, round: timer.round, voters: [], totals: { extend: 0, none: 0, end: 0 } };
  return next;
}
