import { expect, it } from 'vitest';
import { ANN, BOB, NOW, OWNER, board, brokenInvariants, run } from '../test/engine-fixtures';
import { votesUsedBy } from './board';
import { openTimeUpVote } from './discussion';
import { migrateBoard } from './migrate';
import type { BoardState, Command } from './types';

// A small seeded generator, so a failure can be replayed exactly.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTORS = [OWNER, OWNER, ANN, BOB, 'stranger-id'];

function randomCommand(s: BoardState, rnd: () => number): Command {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  // Mostly real topics, and mostly the one being discussed for the discussion commands, so they get applied.
  const existing = s.topics.map((t) => t.topicId);
  const topicId = existing.length && rnd() < 0.9 ? pick(existing) : 1 + Math.floor(rnd() * s.topicIdSeed);
  const current = s.topics.find((t) => t.column === 'discussing')?.topicId;
  const focus = current !== undefined && rnd() < 0.8 ? current : topicId;
  const round = rnd() < 0.8 ? s.voteRound : s.voteRound - 1;
  const commands: Command[] = [
    { type: 'addTopic', text: pick(['', 'Short', 'x'.repeat(280), 'x'.repeat(281)]) },
    { type: 'addTopic', text: `Topic ${Math.floor(rnd() * 1000)}` },
    { type: 'editTopic', topicId, text: pick(['', 'Edited', 'x'.repeat(281)]) },
    { type: 'deleteTopic', topicId },
    { type: 'addVote', topicId },
    { type: 'addVote', topicId },
    { type: 'removeVote', topicId },
    { type: 'raiseAllowance', votes: pick([3, 4, 5, 8, 10]) },
    { type: 'clearVotes' },
    { type: 'setShowVotes', value: rnd() < 0.5 },
    { type: 'startDiscussion' },
    { type: 'backToTopics' },
    { type: 'discussTopic', topicId, minutes: pick([1, 5, 7]), realMinutes: rnd() < 0.5 },
    { type: 'discussTopic', topicId, minutes: 5 },
    { type: 'stopTimer', topicId: focus },
    { type: 'restartTimer', topicId: focus, minutes: pick([1, 2, 6]) },
    { type: 'returnTopic', topicId: focus },
    { type: 'finishTopic', topicId: focus },
    { type: 'voteToContinue', topicId: focus, round, choice: pick(['extend', 'none', 'end', 'maybe']) },
    { type: 'extendTopic', topicId: focus, round, minutes: pick([0, 1, 3, 5, 6]) },
    { type: 'setTimerSound', sound: pick(['chime', 'bell', 'airhorn']) },
    { type: 'endMeeting' },
    { type: 'reopenMeeting' },
  ];
  // Ending is rarer, so most of the run happens in a live meeting.
  const cmd = pick(commands);
  return cmd.type === 'endMeeting' && rnd() < 0.7 ? { type: 'clearVotes' } : cmd;
}

function problems(s: BoardState): string[] {
  const found = brokenInvariants(s);
  for (const id of Object.keys(s.attendees)) {
    if (votesUsedBy(s, id) > s.voteAllowance) found.push(`${id} has more dots than the allowance`);
  }
  const vote = s.continueVote;
  if (vote) {
    if (new Set(vote.voters).size !== vote.voters.length) found.push('someone voted twice');
    if (vote.totals.extend + vote.totals.none + vote.totals.end !== vote.voters.length) found.push('totals and voters disagree');
  }
  if (s.timer && s.timer.round > s.voteRound) found.push('timer round above voteRound');
  const discussed = s.topics.filter((t) => t.column === 'discussed').map((t) => t.topicId).sort((a, b) => a - b);
  if (JSON.stringify([...s.discussedOrder].sort((a, b) => a - b)) !== JSON.stringify(discussed)) found.push('discussedOrder and Discussed disagree');
  return found;
}

// Each seed is 3000 steps of pure CPU work (every step serialises the board several times), about 0.7 s alone.
// Vitest's 5 s default is only about 7 times that, which a loaded or single-core machine can exceed. The timeout is
// sized to the work rather than the work cut, so every seed keeps its 3000 steps.
it.each([1, 2, 3, 20261006])('keeps every invariant through a seeded random run of commands and ticks (seed %i)', (seed) => {
  const rnd = mulberry32(seed);
  let s = board();
  let now = NOW;
  let accepted = 0;
  let previousRound = s.voteRound;
  for (let step = 0; step < 3000; step++) {
    now += Math.floor(rnd() * 120_000);
    const before = JSON.stringify(s);
    if (rnd() < 0.1) {
      s = openTimeUpVote(s, now) ?? s;
    } else {
      const actor = ACTORS[Math.floor(rnd() * ACTORS.length)];
      const r = run(s, actor, randomCommand(s, rnd), now);
      if (r.ok) {
        s = r.state;
        accepted += 1;
      } else {
        expect(JSON.stringify(s)).toBe(before);
      }
    }
    const found = problems(s);
    if (s.voteRound < previousRound) found.push('voteRound went down');
    previousRound = s.voteRound;
    // Migrating a board the engine produced must change nothing.
    if (JSON.stringify(migrateBoard(s, s.timer?.endsAt ?? now)) !== JSON.stringify(s)) found.push('migrateBoard changed an engine board');
    if (found.length) throw new Error(`step ${step}: ${found.join('; ')}`);
  }
  expect(accepted).toBeGreaterThan(300);
}, 60_000);
