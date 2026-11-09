import { apply } from '../engine/apply';
import { createBoard } from '../engine/board';
import type { BoardState, Command } from '../engine/types';

export const ADVERSARIAL_SEED = 20261006;

const WORDS = ['trunk', 'based', 'development', 'release', 'cadence', 'pairing', 'on', 'call', 'rota', 'the', 'team',
  'retro', 'format', 'should', 'we', 'try', 'testing', 'in', 'production', 'how', 'to', 'onboard', 'new', 'people',
  'faster', 'roadmap', 'review', 'tech', 'debt', 'budget', 'meetings', 'without', 'agendas', 'and', 'focus', 'time'];

// A topic of exactly `length` characters made of English words.
export function sentence(i: number, length: number): string {
  let text = '';
  for (let w = i; text.length < length; w++) text += `${text ? ' ' : ''}${WORDS[(w * 7) % WORDS.length]}`;
  return text.slice(0, length).trimEnd().padEnd(length, '.');
}

function run(state: BoardState, actor: string, cmd: Command): BoardState {
  const result = apply(state, actor, cmd, 1_760_000_000_000);
  if (!result.ok) throw new Error(`${cmd.type}: ${result.key}`);
  return result.state;
}

// docs/product/sync-protocol.md, Size: 30 English topics of 50 to 110 characters (80 on average), 15 people with
// 12-character names, and each person with three dots.
export function realisticBoard(): BoardState {
  let state = createBoard({ boardId: 'realistic-board', boardName: 'Team Lean Coffee', ownerId: 'owner', ownerName: 'Attendee0000' });
  const people = ['owner'];
  for (let i = 1; i < 15; i++) {
    const id = `person-${i}`;
    state = run(state, id, { type: 'join', name: `Attendee${String(i).padStart(4, '0')}` });
    people.push(id);
  }
  for (let i = 0; i < 30; i++) state = run(state, people[i % people.length], { type: 'addTopic', text: sentence(i, 50 + Math.round((i * 60) / 29)) });
  people.forEach((id, p) => {
    for (let d = 0; d < 3; d++) state = run(state, id, { type: 'addVote', topicId: 1 + ((p * 3 + d) % 30) });
  });
  return state;
}

// Random characters cycling through CJK ideographs (3 bytes in UTF-8), emoji (4 bytes), CJK Extension B (4 bytes)
// and CJK again: random rather than repeated, so deflate can't shrink it much.
const RANGES: Array<[number, number]> = [[0x4e00, 0x9fff], [0x1f300, 0x1faff], [0x20000, 0x2a6df], [0x4e00, 0x9fff]];

export function adversarialText(random: () => number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) {
    const [lo, hi] = RANGES[i % RANGES.length];
    text += String.fromCodePoint(lo + Math.floor(random() * (hi - lo + 1)));
  }
  return text;
}
