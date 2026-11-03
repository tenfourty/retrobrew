import { describe, expect, it } from 'vitest';
import { ANN, BOB, OWNER, board, must, refused, run, steps, withTopic } from '../test/engine-fixtures';
import { votesLeft } from './board';
import type { BoardState, ColumnId } from './types';

// The board after Start discussion, set up by hand so these tests don't depend on it.
function discussing(s: BoardState): BoardState {
  const next = structuredClone(s);
  next.phase = 'discussion';
  for (const t of next.topics) if (t.column === 'ideas') t.column = 'toDiscuss';
  return next;
}

function moved(s: BoardState, topicId: number, column: ColumnId): BoardState {
  const next = structuredClone(s);
  next.topics.find((t) => t.topicId === topicId)!.column = column;
  return next;
}

describe('addTopic', () => {
  it('numbers topics and puts the newest first in Ideas', () => {
    const s = must(run(withTopic(), BOB, { type: 'addTopic', text: '  Second  ' }));
    const [first, second] = s.topics;
    expect(first).toMatchObject({ topicId: 1, position: 0 });
    expect(second).toMatchObject({ topicId: 2, text: 'Second', authorId: BOB, column: 'ideas', position: -1 });
    expect(s.topicIdSeed).toBe(3);
  });

  it('never reuses a number, even after a delete', () => {
    let s = must(run(withTopic(), ANN, { type: 'deleteTopic', topicId: 1 }));
    s = must(run(s, ANN, { type: 'addTopic', text: 'Again' }));
    expect(s.topics[0].topicId).toBe(2);
  });

  it('in discussion, adds to To discuss after every topic there', () => {
    let s = discussing(steps(board(), [[ANN, { type: 'addTopic', text: 'a' }], [ANN, { type: 'addTopic', text: 'b' }]]));
    s = must(run(s, BOB, { type: 'addTopic', text: 'late' }));
    expect(s.topics[2]).toMatchObject({ column: 'toDiscuss', position: 1 });
  });

  it('gives position 0 to a topic added to an empty column', () => {
    const s = must(run(discussing(board()), BOB, { type: 'addTopic', text: 'first' }));
    expect(s.topics[0]).toMatchObject({ column: 'toDiscuss', position: 0 });
  });

  it('turns line breaks into spaces and counts code points, so an emoji is one character', () => {
    const s = must(run(board(), ANN, { type: 'addTopic', text: ' one\r\ntwo\nthree ' }));
    expect(s.topics[0].text).toBe('one two three');
    expect(run(board(), ANN, { type: 'addTopic', text: '😀'.repeat(280) }).ok).toBe(true);
    expect(run(board(), ANN, { type: 'addTopic', text: '😀'.repeat(281) })).toEqual(refused('topicTooLong'));
  });

  it('refuses empty and over-long topics', () => {
    expect(run(board(), ANN, { type: 'addTopic', text: ' \n ' })).toEqual(refused('emptyTopic'));
    expect(run(board(), ANN, { type: 'addTopic', text: 'x'.repeat(281) })).toEqual(refused('topicTooLong'));
  });

  it('refuses a 61st topic, counting every column', () => {
    let s = board();
    for (let i = 0; i < 59; i++) s = must(run(s, ANN, { type: 'addTopic', text: `t${i}` }));
    s = moved(must(run(s, ANN, { type: 'addTopic', text: 'last' })), 1, 'discussed');
    expect(s.topics).toHaveLength(60);
    expect(run(s, BOB, { type: 'addTopic', text: 'one more' })).toEqual(refused('tooManyTopics'));
    // The text is checked before the count.
    expect(run(s, BOB, { type: 'addTopic', text: '  ' })).toEqual(refused('emptyTopic'));
    expect(run(s, BOB, { type: 'addTopic', text: 'x'.repeat(281) })).toEqual(refused('topicTooLong'));
  });
});

describe('editTopic', () => {
  it('lets the author replace the text, cleaned like a new topic', () => {
    const s = must(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: ' Better\nwording ' }));
    expect(s.topics[0].text).toBe('Better wording');
  });

  it('checks in order: exists, author, column, length', () => {
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 9, text: 'x' })).toEqual(refused('noSuchTopic'));
    expect(run(withTopic(), OWNER, { type: 'editTopic', topicId: 1, text: 'x' })).toEqual(refused('notYourTopicToEdit'));
    expect(run(moved(withTopic(), 1, 'discussing'), ANN, { type: 'editTopic', topicId: 1, text: 'x'.repeat(300) }))
      .toEqual(refused('cantEditNow'));
    expect(run(moved(withTopic(), 1, 'discussed'), ANN, { type: 'editTopic', topicId: 1, text: 'x' })).toEqual(refused('cantEditNow'));
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: 'x'.repeat(281) })).toEqual(refused('topicTooLong'));
  });

  it('allows editing in To discuss', () => {
    const s = must(run(discussing(withTopic()), ANN, { type: 'editTopic', topicId: 1, text: 'Changed' }));
    expect(s.topics[0].text).toBe('Changed');
  });

  it('deletes the topic when the text is empty after trimming, giving its votes back', () => {
    let s = must(run(withTopic(), BOB, { type: 'addVote', topicId: 1 }));
    s = must(run(s, ANN, { type: 'editTopic', topicId: 1, text: '  ' }));
    expect(s.topics).toEqual([]);
    expect(votesLeft(s, BOB)).toBe(3);
  });

  it('accepts the same text without changing the board', () => {
    const s = withTopic();
    expect(run(s, ANN, { type: 'editTopic', topicId: 1, text: 'First topic' })).toEqual({ ok: true, state: s, changed: false });
  });
});

describe('deleteTopic', () => {
  it('lets the author or a facilitator delete, but not another guest', () => {
    expect(run(withTopic(), BOB, { type: 'deleteTopic', topicId: 1 })).toEqual(refused('notYourTopic'));
    expect(must(run(withTopic(), ANN, { type: 'deleteTopic', topicId: 1 })).topics).toHaveLength(0);
    expect(must(run(withTopic(), OWNER, { type: 'deleteTopic', topicId: 1 })).topics).toHaveLength(0);
  });

  it('refuses a topic that no longer exists', () => {
    expect(run(withTopic(), ANN, { type: 'deleteTopic', topicId: 9 })).toEqual(refused('noSuchTopic'));
  });

  it('keeps Discussing and Discussed topics on the board', () => {
    expect(run(moved(withTopic(), 1, 'discussing'), OWNER, { type: 'deleteTopic', topicId: 1 })).toEqual(refused('discussedStays'));
    expect(run(moved(withTopic(), 1, 'discussed'), ANN, { type: 'deleteTopic', topicId: 1 })).toEqual(refused('discussedStays'));
  });

  it('gives the dots back to everyone who placed them', () => {
    const s = steps(withTopic(), [[BOB, { type: 'addVote', topicId: 1 }], [ANN, { type: 'addVote', topicId: 1 }], [OWNER, { type: 'deleteTopic', topicId: 1 }]]);
    expect(votesLeft(s, BOB)).toBe(3);
    expect(votesLeft(s, ANN)).toBe(3);
  });
});

describe('cap routes', () => {
  it('counts padding and line breaks after normalisation, on add and on edit', () => {
    const exact = 'x'.repeat(280);
    expect(run(board(), ANN, { type: 'addTopic', text: `  \n${exact}\r\n  ` }).ok).toBe(true);
    expect(run(board(), ANN, { type: 'addTopic', text: `${exact}\n` + 'y' })).toEqual(refused('topicTooLong'));
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: `\n ${exact} \n` }).ok).toBe(true);
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: `${'x'.repeat(140)}\n${'x'.repeat(140)}` })).toEqual(refused('topicTooLong'));
  });

  it('edit counts emoji and surrogate pairs as one character each', () => {
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: '😀'.repeat(280) }).ok).toBe(true);
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: '😀'.repeat(281) })).toEqual(refused('topicTooLong'));
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: '\u{1F468}‍\u{1F469}'.repeat(93) + 'ab' }).ok).toBe(false);
  });

  it('refuses the 61st topic even when every topic is in To discuss', () => {
    let s = board();
    for (let i = 0; i < 60; i++) s = must(run(s, ANN, { type: 'addTopic', text: `t${i}` }));
    s = discussing(s);
    expect(run(s, BOB, { type: 'addTopic', text: 'late' })).toEqual(refused('tooManyTopics'));
  });
});
