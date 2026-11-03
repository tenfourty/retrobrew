import { votesUsedBy } from './board';
import { changed, refuse, unchanged } from './result';
import { OPEN_COLUMNS } from './topics';
import { VOTE_ALLOWANCES, type BoardState, type CommandOf, type Result } from './types';

// Dots can be added or removed only on topics in Ideas and To discuss.
export function addVote(state: BoardState, actor: string, cmd: CommandOf<'addVote'>): Result {
  const index = state.topics.findIndex((t) => t.topicId === cmd.topicId);
  if (index === -1) return refuse('noSuchTopic');
  if (!OPEN_COLUMNS.includes(state.topics[index].column)) return refuse('voteNotOpen');
  if (votesUsedBy(state, actor) >= state.voteAllowance) return refuse('noVotesLeft');
  const next = structuredClone(state);
  next.topics[index].voters.push(actor);
  return changed(next);
}

export function removeVote(state: BoardState, actor: string, cmd: CommandOf<'removeVote'>): Result {
  const index = state.topics.findIndex((t) => t.topicId === cmd.topicId);
  if (index === -1) return refuse('noSuchTopic');
  if (!OPEN_COLUMNS.includes(state.topics[index].column)) return refuse('votesSpent');
  const dot = state.topics[index].voters.indexOf(actor);
  if (dot === -1) return refuse('notYourVote');
  const next = structuredClone(state);
  next.topics[index].voters.splice(dot, 1);
  return changed(next);
}

// The allowance only ever goes up. The same value again is accepted and changes nothing.
export function raiseAllowance(state: BoardState, cmd: CommandOf<'raiseAllowance'>): Result {
  if (!(VOTE_ALLOWANCES as readonly number[]).includes(cmd.votes)) return refuse('badVoteAllowance');
  if (cmd.votes < state.voteAllowance) return refuse('fewerVotes');
  if (cmd.votes === state.voteAllowance) return unchanged(state);
  return changed({ ...structuredClone(state), voteAllowance: cmd.votes });
}

// Gives back only the dots on Ideas and To discuss topics; dots on discussed topics stay spent.
export function clearVotes(state: BoardState): Result {
  const next = structuredClone(state);
  for (const t of next.topics) if (OPEN_COLUMNS.includes(t.column)) t.voters = [];
  return changed(next);
}

export function setShowVotes(state: BoardState, cmd: CommandOf<'setShowVotes'>): Result {
  if (cmd.value === state.showVotes) return unchanged(state);
  return changed({ ...structuredClone(state), showVotes: cmd.value });
}
