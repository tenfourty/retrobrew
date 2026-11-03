import { describe, expect, it } from 'vitest';
import type { Timer, TopicView } from '../engine/types';
import { announcementsBetween, countdownAnnouncement, lengthNotice, TIME_UP_ANNOUNCEMENT } from './announce';

const topic = (topicId: number, column: TopicView['column'], text = `Topic ${topicId}`): TopicView =>
  ({ topicId, text, column, position: 0, authorId: 'a', votes: 0, mine: 0 });
const board = (phase: 'topics' | 'discussion' | 'ended', topics: TopicView[] = [], vote: { topicId: number; round: number } | null = null) =>
  ({ phase, topics, vote: vote ? { ...vote, voted: false, turnout: { voted: 0, here: 1 } } : null });

describe('announcementsBetween', () => {
  it('says nothing for the first view', () => {
    expect(announcementsBetween(null, board('discussion', [topic(1, 'discussing')]))).toEqual([]);
  });

  it('announces each phase change', () => {
    expect(announcementsBetween(board('topics'), board('discussion'))).toEqual(['Discussion started']);
    expect(announcementsBetween(board('discussion'), board('topics'))).toEqual(['Back to collecting topics']);
    expect(announcementsBetween(board('discussion'), board('ended'))).toEqual(['Meeting ended']);
    expect(announcementsBetween(board('topics'), board('ended'))).toEqual(['Meeting ended']);
    expect(announcementsBetween(board('ended'), board('discussion'))).toEqual(['Meeting reopened']);
  });

  it('says nothing when nothing changed', () => {
    const same = board('discussion', [topic(1, 'discussing')]);
    expect(announcementsBetween(same, same)).toEqual([]);
  });

  it('announces a topic starting, but not one that was already in Discussing', () => {
    const before = board('discussion', [topic(4, 'toDiscuss', 'Hiring')]);
    const after = board('discussion', [topic(4, 'discussing', 'Hiring')]);
    expect(announcementsBetween(before, after)).toEqual(['Now discussing #4: Hiring']);
    expect(announcementsBetween(after, after)).toEqual([]);
  });

  it('reads a phase change and a topic starting together, and a reopened meeting with a topic in Discussing as reopened only', () => {
    const before = board('topics', [topic(2, 'ideas')]);
    expect(announcementsBetween(before, board('discussion', [topic(2, 'discussing', 'Pairing')]))).toEqual(['Discussion started', 'Now discussing #2: Pairing']);
    const ended = board('ended', [topic(2, 'discussed')]);
    expect(announcementsBetween(ended, board('discussion', [topic(2, 'discussed')]))).toEqual(['Meeting reopened']);
  });

  it('announces time up once for each vote, and again for a new round on the same topic', () => {
    const running = board('discussion', [topic(4, 'discussing')]);
    const open = board('discussion', [topic(4, 'discussing')], { topicId: 4, round: 1 });
    expect(announcementsBetween(running, open)).toEqual([TIME_UP_ANNOUNCEMENT]);
    expect(announcementsBetween(open, open)).toEqual([]);
    expect(announcementsBetween(open, running)).toEqual([]);
    expect(announcementsBetween(open, board('discussion', [topic(4, 'discussing')], { topicId: 4, round: 2 }))).toEqual([TIME_UP_ANNOUNCEMENT]);
  });
});

describe('countdownAnnouncement', () => {
  const timer = (totalMs: number, minuteMs = 60_000): Timer => ({ topicId: 4, startedAt: 0, endsAt: totalMs, round: 1, minuteMs });

  it('speaks at one timebox minute left, in seconds on a rehearsal timer', () => {
    expect(countdownAnnouncement(timer(300_000), 60_000)).toBe('1 minute left');
    expect(countdownAnnouncement(timer(300_000), 56_000)).toBe('1 minute left');
    expect(countdownAnnouncement(timer(50_000, 10_000), 10_000)).toBe('10 seconds left');
  });

  it('is silent before that, after time is up, without a timer, and for a timer no longer than a minute', () => {
    expect(countdownAnnouncement(timer(300_000), 60_001)).toBeNull();
    expect(countdownAnnouncement(timer(300_000), 0)).toBeNull();
    expect(countdownAnnouncement(timer(300_000), 30_000)).toBeNull();
    expect(countdownAnnouncement(timer(50_000, 10_000), 4_000)).toBeNull();
    expect(countdownAnnouncement(null, 30_000)).toBeNull();
    expect(countdownAnnouncement(timer(60_000), 30_000)).toBeNull();
  });
});

describe('lengthNotice', () => {
  const text = (n: number) => 'a'.repeat(n);

  it('speaks when the draft reaches 240, 260 and 280 characters', () => {
    expect(lengthNotice(text(239), text(240))).toBe('40 characters left');
    expect(lengthNotice(text(259), text(260))).toBe('20 characters left');
    expect(lengthNotice(text(279), text(280))).toBe('0 characters left');
  });

  it('is silent between the marks, when shrinking, and when nothing changes', () => {
    expect(lengthNotice(text(240), text(241))).toBeNull();
    expect(lengthNotice(text(260), text(259))).toBeNull();
    expect(lengthNotice(text(280), text(280))).toBeNull();
    expect(lengthNotice(text(10), text(11))).toBeNull();
  });

  it('speaks once for a paste that crosses several marks, and counts code points', () => {
    expect(lengthNotice('', text(280))).toBe('0 characters left');
    expect(lengthNotice('', '😀'.repeat(279) + 'a')).toBe('0 characters left');
    expect(lengthNotice(text(239), text(279))).toBe('1 character left');
  });
});
