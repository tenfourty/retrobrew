import { describe, expect, it } from 'vitest';
import type { TopicView } from '../engine/types';
import { shortTopic, STRIP_IDLE, stripContent, switchToDiscussing } from './status-strip';

const long = 'Should we adopt trunk-based development this quarter?';
const topic: TopicView = { topicId: 4, text: long, column: 'discussing', position: 0, authorId: 'a', votes: 2, mine: 0 };
const timer = { topicId: 4, startedAt: 0, endsAt: 300_000, round: 3, minuteMs: 60_000 };

describe('shortTopic', () => {
  it('keeps 24 characters and adds an ellipsis only when longer', () => {
    expect(shortTopic(long)).toBe('Should we adopt trunk-ba…');
    expect(shortTopic('Hiring plan')).toBe('Hiring plan');
    expect(shortTopic('😀'.repeat(30))).toBe(`${'😀'.repeat(24)}…`);
  });
});

describe('stripContent', () => {
  it('says the next topic is coming up when nothing is in Discussing', () => {
    expect(stripContent({ topics: [], timer: null, vote: null }, null)).toEqual({ idle: true, chip: false, label: STRIP_IDLE });
  });

  it('shows the countdown, No timer, or Time’s up with the Vote chip', () => {
    expect(stripContent({ topics: [topic], timer, vote: null }, 192)).toMatchObject({ number: 4, short: 'Should we adopt trunk-ba…', end: '3:12', chip: false });
    expect(stripContent({ topics: [topic], timer: null, vote: null }, null)).toMatchObject({ end: 'No timer', chip: false });
    const vote = { topicId: 4, round: 3, voted: false, turnout: { voted: 0, here: 3 } };
    expect(stripContent({ topics: [topic], timer, vote }, 0)).toMatchObject({ end: "Time's up", chip: true });
  });

  it('names the strip with the topic’s full text, and never with the running countdown', () => {
    expect(stripContent({ topics: [topic], timer, vote: null }, 192).label).toBe(`Discussing #4 ${long}`);
    expect(stripContent({ topics: [topic], timer, vote: null }, 191).label).toBe(`Discussing #4 ${long}`);
    expect(stripContent({ topics: [topic], timer: null, vote: null }, null).label).toBe(`Discussing #4 ${long}, No timer`);
    const vote = { topicId: 4, round: 3, voted: false, turnout: { voted: 0, here: 3 } };
    expect(stripContent({ topics: [topic], timer, vote }, 0).label).toBe(`Discussing #4 ${long}, Time's up`);
  });
});

describe('switchToDiscussing', () => {
  it('switches when a topic starts, unless someone is typing', () => {
    expect(switchToDiscussing(undefined, 4, false)).toBe(true);
    expect(switchToDiscussing(3, 4, false)).toBe(true);
    expect(switchToDiscussing(4, 4, false)).toBe(false);
    expect(switchToDiscussing(4, undefined, false)).toBe(false);
    expect(switchToDiscussing(undefined, 4, true)).toBe(false);
  });
});
