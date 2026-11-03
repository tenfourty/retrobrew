import { isFacilitator } from './board';
import { MAX_TOPIC, MAX_TOPICS, cleanTopic, codePoints, utf8Bytes } from './limits';
import { changed, growing, refuse, unchanged } from './result';
import type { BoardState, ColumnId, CommandOf, Result, Topic } from './types';

// Topics in these columns can still be edited, deleted and voted on.
export const OPEN_COLUMNS: readonly ColumnId[] = ['ideas', 'toDiscuss'];

const isOpen = (topic: Topic) => OPEN_COLUMNS.includes(topic.column);

export function addTopic(state: BoardState, actor: string, cmd: CommandOf<'addTopic'>): Result {
  const text = cleanTopic(cmd.text);
  if (!text) return refuse('emptyTopic');
  if (codePoints(text) > MAX_TOPIC) return refuse('topicTooLong');
  if (state.topics.length >= MAX_TOPICS) return refuse('tooManyTopics');
  // In topics a new topic is first in Ideas; in discussion it goes after every topic in To discuss.
  const column: ColumnId = state.phase === 'discussion' ? 'toDiscuss' : 'ideas';
  const orders = state.topics.filter((t) => t.column === column).map((t) => t.position);
  let position = 0;
  if (orders.length) position = column === 'ideas' ? Math.min(...orders) - 1 : Math.max(...orders) + 1;
  const next = structuredClone(state);
  next.topics.push({
    topicId: next.topicIdSeed, text: text, column, position,
    authorId: actor, voters: [],
  });
  next.topicIdSeed += 1;
  return growing(next, 'boardFull');
}

export function editTopic(state: BoardState, actor: string, cmd: CommandOf<'editTopic'>): Result {
  const topic = state.topics.find((t) => t.topicId === cmd.topicId);
  if (!topic) return refuse('noSuchTopic');
  if (topic.authorId !== actor) return refuse('notYourTopicToEdit');
  if (!isOpen(topic)) return refuse('cantEditNow');
  const text = cleanTopic(cmd.text);
  if (!text) return deleteTopic(state, actor, { type: 'deleteTopic', topicId: cmd.topicId });
  // A board loaded over the limits may still shorten a long topic; only growth is refused.
  if (codePoints(text) > MAX_TOPIC && codePoints(text) > codePoints(topic.text)) return refuse('topicTooLong');
  if (text === topic.text) return unchanged(state);
  const next = structuredClone(state);
  next.topics.find((t) => t.topicId === cmd.topicId)!.text = text;
  // "Longer" is measured in UTF-8 bytes, which is what the size cap counts.
  return utf8Bytes(text) > utf8Bytes(topic.text) ? growing(next, 'boardFull') : changed(next);
}

// Removing the topic removes its dots, which gives those votes back.
export function deleteTopic(state: BoardState, actor: string, cmd: CommandOf<'deleteTopic'>): Result {
  const topic = state.topics.find((t) => t.topicId === cmd.topicId);
  if (!topic) return refuse('noSuchTopic');
  if (topic.authorId !== actor && !isFacilitator(state, actor)) return refuse('notYourTopic');
  if (!isOpen(topic)) return refuse('discussedStays');
  const next = structuredClone(state);
  next.topics = next.topics.filter((t) => t.topicId !== cmd.topicId);
  return changed(next);
}
