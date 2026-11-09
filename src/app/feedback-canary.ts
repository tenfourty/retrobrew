import { registerCanary } from '../feedback/errors';

/** The parts of a board view whose text must never reach a report: the name, the topics and the people's names. */
export interface CanaryView {
  boardId: string;
  boardName: string;
  topics: ReadonlyArray<{ text: string }>;
  attendees: Readonly<Record<string, { name: string }>>;
}

/** Every string the open board holds that a report must not carry: its words, its id, its key and the page's whole fragment. */
export function boardStrings(view: CanaryView, hash: string): string[] {
  return [view.boardName, view.boardId, ...view.topics.map((t) => t.text), ...Object.values(view.attendees).map((a) => a.name), ...fragmentStrings(hash)];
}

/** The page's own link fragment as strings to withhold: the whole fragment and each of its values (board id, key, host key). Needs no state. */
export function fragmentStrings(hash: string): string[] {
  const strings = [hash];
  for (const [, value] of new URLSearchParams(hash.replace(/^#/, ''))) strings.push(value);
  return strings;
}

/** Tells the error scrubber the page's link fragment before the meeting starts, so a start-up error that quotes it is withheld. */
export function registerFragmentStrings(hash: string): void {
  registerCanary(fragmentStrings(hash));
}

/** Tells the error scrubber what the board holds. Additive; `clearCanary` ends it when the session does. */
export function registerBoardStrings(view: CanaryView, hash: string): void {
  registerCanary(boardStrings(view, hash));
}
