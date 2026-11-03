import { describe, expect, it } from 'vitest';
import { ANN, BOB, NOW, OWNER, board, must, refused, run, withTopic } from '../test/engine-fixtures';
import { apply } from './apply';
import { createBoard } from './board';
import { parseCommand } from './parse';
import type { BoardState } from './types';

function ended(): BoardState {
  return { ...withTopic(), phase: 'ended', endedAt: NOW };
}

describe('the order of checks', () => {
  it('refuses anyone who has not joined, before anything else', () => {
    expect(run(board(), 'stranger', { type: 'addTopic', text: 'x' })).toEqual(refused('notAttendee'));
    expect(run(ended(), 'stranger', { type: 'setShowVotes', value: false })).toEqual(refused('notAttendee'));
  });
  it('refuses a guest a facilitator command, before checking the phase', () => {
    expect(run(ended(), ANN, { type: 'setShowVotes', value: false })).toEqual(refused('facilitatorOnly'));
  });
  it('refuses everything but join once the meeting has ended', () => {
    expect(run(ended(), ANN, { type: 'addTopic', text: 'late' })).toEqual(refused('ended'));
    expect(run(ended(), ANN, { type: 'addVote', topicId: 1 })).toEqual(refused('ended'));
    expect(run(ended(), OWNER, { type: 'setShowVotes', value: false })).toEqual(refused('ended'));
  });
  it('refuses someone whose attendee entry is gone as not joined, even the owner', () => {
    const s = board();
    delete s.attendees[OWNER];
    expect(run(s, OWNER, { type: 'setShowVotes', value: false })).toEqual(refused('notAttendee'));
  });
  it('gives the refusal key and its message', () => {
    expect(run(board(), 'stranger', { type: 'addTopic', text: 'x' })).toEqual({ ok: false, key: 'notAttendee', message: 'Join the meeting first' });
  });
});

it('cuts a meeting name to 80 characters at creation', () => {
  const s = createBoard({ boardId: 'b', boardName: ` ${'😀'.repeat(90)} `, ownerId: OWNER, ownerName: 'Olu' });
  expect([...s.boardName]).toHaveLength(80);
});

describe('joining', () => {
  it('adds a guest with a trimmed name', () => {
    expect(board().attendees[ANN]).toEqual({ id: ANN, name: 'Ann', role: 'guest' });
  });
  it('renames on rejoin without changing the role', () => {
    const s = must(run(board(), OWNER, { type: 'join', name: 'Olu B' }));
    expect(s.attendees[OWNER]).toEqual({ id: OWNER, name: 'Olu B', role: 'owner' });
  });
  it('accepts a join that changes nothing, without changing the board', () => {
    const s = board();
    const r = run(s, ANN, { type: 'join', name: 'Ann' });
    expect(r).toEqual({ ok: true, state: s, changed: false });
  });
  it('cuts a name to 60 characters, counting an emoji as one', () => {
    const s = must(run(board(), 'new', { type: 'join', name: '😀'.repeat(70) }));
    expect([...s.attendees.new.name]).toHaveLength(60);
  });
  it('refuses an empty name', () => {
    expect(run(board(), 'new', { type: 'join', name: '  ' })).toEqual(refused('emptyName'));
  });
  it('refuses a 61st person but lets anyone on the list rejoin', () => {
    let s = board();
    for (let i = Object.keys(s.attendees).length; i < 60; i++) s = must(run(s, `p${i}`, { type: 'join', name: `P${i}` }));
    expect(Object.keys(s.attendees)).toHaveLength(60);
    expect(run(s, 'one-too-many', { type: 'join', name: 'Late' })).toEqual(refused('meetingFull'));
    expect(must(run(s, ANN, { type: 'join', name: 'Ann again' })).attendees[ANN].name).toBe('Ann again');
  });
  it('allows joining after the end, so latecomers see the final board', () => {
    expect(must(run(ended(), 'late', { type: 'join', name: 'Late' })).attendees.late.role).toBe('guest');
  });
});

it('never mutates the state it is given', () => {
  const s = must(run(withTopic(), OWNER, { type: 'startDiscussion' }));
  const before = JSON.stringify(s);
  run(s, BOB, { type: 'addVote', topicId: 1 });
  run(s, OWNER, { type: 'discussTopic', topicId: 1, minutes: 5 });
  run(s, ANN, { type: 'editTopic', topicId: 1, text: 'Changed' });
  run(s, OWNER, { type: 'endMeeting' });
  run(s, ANN, { type: 'join', name: 'Ann B' });
  expect(JSON.stringify(s)).toBe(before);
});

it('refuses a command the engine does not know', () => {
  expect(apply(withTopic(), OWNER, { type: 'dropTables' } as never, NOW)).toEqual(refused('badCommand'));
});

describe('parseCommand', () => {
  it('accepts well-formed commands', () => {
    expect(parseCommand({ type: 'addVote', topicId: 3 })).toEqual({ type: 'addVote', topicId: 3 });
    expect(parseCommand({ type: 'discussTopic', topicId: 1, minutes: 5 })).toEqual({ type: 'discussTopic', topicId: 1, minutes: 5 });
    expect(parseCommand({ type: 'restartTimer', topicId: 1, minutes: 5, realMinutes: true }))
      .toEqual({ type: 'restartTimer', topicId: 1, minutes: 5, realMinutes: true });
    expect(parseCommand({ type: 'endMeeting', extra: 'ignored' })).toEqual({ type: 'endMeeting' });
  });
  it('leaves rule values to the engine, so it can refuse them with their own message', () => {
    expect(parseCommand({ type: 'discussTopic', topicId: 1, minutes: 7 })).toEqual({ type: 'discussTopic', topicId: 1, minutes: 7 });
    expect(parseCommand({ type: 'raiseAllowance', votes: 4 })).toEqual({ type: 'raiseAllowance', votes: 4 });
    expect(parseCommand({ type: 'setTimerSound', sound: 'airhorn' })).toEqual({ type: 'setTimerSound', sound: 'airhorn' });
  });
  it('rejects unknown types and wrong field types', () => {
    expect(parseCommand({ type: 'dropTables' })).toBeNull();
    expect(parseCommand({ type: 'addVote', topicId: '3' })).toBeNull();
    expect(parseCommand({ type: 'addVote', topicId: 1.5 })).toBeNull();
    expect(parseCommand({ type: 'addTopic', text: 42 })).toBeNull();
    expect(parseCommand({ type: 'startTimer', topicId: 1, minutes: 5 })).toBeNull();
    expect(parseCommand({ type: 'discussTopic', topicId: 1, minutes: '5' })).toBeNull();
    expect(parseCommand({ type: 'discussTopic', topicId: 1, minutes: 5, realMinutes: 'yes' })).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });
});
