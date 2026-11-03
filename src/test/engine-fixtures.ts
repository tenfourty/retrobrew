import { apply } from '../engine/apply';
import { createBoard } from '../engine/board';
import { MESSAGES, type MessageKey } from '../engine/messages';
import type { BoardState, Command, Result } from '../engine/types';

// Small, deterministic boards for the engine tests.
export const OWNER = 'owner-id';
export const ANN = 'ann-id';
export const BOB = 'bob-id';
export const NOW = 1_000_000;

export function must(r: Result): BoardState {
  if (!r.ok) throw new Error(r.message);
  return r.state;
}

export const run = (s: BoardState, actor: string, cmd: Command, now = NOW): Result => apply(s, actor, cmd, now);

export const refused = (key: MessageKey): Result => ({ ok: false, key, message: MESSAGES[key] });

// Applies each [actor, command] in turn, failing loudly on any refusal.
export function steps(s: BoardState, list: Array<[string, Command]>, now = NOW): BoardState {
  return list.reduce((state, [actor, cmd]) => must(run(state, actor, cmd, now)), s);
}

// The owner, Ann and Bob, in the topics phase.
export function board(o: { rehearsal?: boolean } = {}): BoardState {
  const s = createBoard({ boardId: 'b1', boardName: 'Team', ownerId: OWNER, ownerName: 'Olu', rehearsal: o.rehearsal });
  return steps(s, [[ANN, { type: 'join', name: ' Ann ' }], [BOB, { type: 'join', name: 'Bob' }]]);
}

// The same board with one topic by Ann, #1.
export function withTopic(): BoardState {
  return must(run(board(), ANN, { type: 'addTopic', text: 'First topic' }));
}

// The invariants of docs/product/lean-coffee-rules.md, Phases and columns. Returns what is broken.
export function brokenInvariants(s: BoardState): string[] {
  const broken: string[] = [];
  const inColumn = (c: string) => s.topics.filter((t) => t.column === c);
  if (s.phase === 'topics' && (inColumn('toDiscuss').length || inColumn('discussing').length)) broken.push('topics phase uses discussion columns');
  if (s.phase === 'discussion' && inColumn('ideas').length) broken.push('discussion phase has Ideas topics');
  if (inColumn('discussing').length > 1) broken.push('more than one topic in Discussing');
  const discussing = inColumn('discussing')[0];
  if (s.timer && s.timer.topicId !== discussing?.topicId) broken.push('timer for a topic not in Discussing');
  if (s.continueVote && (!s.timer || s.continueVote.round !== s.timer.round || s.continueVote.topicId !== s.timer.topicId)) {
    broken.push('time-up vote without its timer');
  }
  if (s.phase === 'ended' && (inColumn('discussing').length || s.timer || s.continueVote)) broken.push('ended board still has a topic, timer or vote in play');
  if ((s.endedAt !== null) !== (s.phase === 'ended')) broken.push('endedAt is set exactly when the phase is ended');
  return broken;
}
