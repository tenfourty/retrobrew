import type { ViewState } from '../engine/types';

const DEFAULTS: ViewState = {
  boardId: '', boardName: '', phase: 'topics', voteAllowance: 3, showVotes: true, rehearsal: false, timerSound: 'chime',
  endedAt: null, discussedOrder: [], topics: [], attendees: {}, online: [], timer: null, vote: null, role: 'guest',
  acks: {}, rejects: {},
};

const isRecord = (x: unknown): boolean => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): boolean => typeof x === 'string';
const isBool = (x: unknown): boolean => typeof x === 'boolean';
const isList = (x: unknown): boolean => Array.isArray(x);
const orNull = (check: (x: unknown) => boolean) => (x: unknown): boolean => x === null || check(x);

// The type each view field must have when it is present.
const CHECKS: Record<keyof ViewState, (x: unknown) => boolean> = {
  boardId: isStr, boardName: isStr, phase: isStr, voteAllowance: isNum, showVotes: isBool, rehearsal: isBool,
  timerSound: isStr, endedAt: orNull(isNum), discussedOrder: isList, topics: isList, attendees: isRecord, online: isList,
  timer: orNull(isRecord), vote: orNull(isRecord), role: isStr, acks: isRecord, rejects: isRecord, joinRefused: isStr,
};

// A view from an older or newer host may lack fields; fill each missing one with its default so the board renders
// (docs/product/sync-protocol.md, Accepting views). A field that is present with the wrong type makes the whole view
// malformed: null, so it is refused rather than throwing later.
export function withViewDefaults(x: Record<string, unknown>): ViewState | null {
  const view: Record<string, unknown> = { ...x };
  for (const [key, check] of Object.entries(CHECKS)) if (view[key] !== undefined && !check(view[key])) return null;
  for (const [key, value] of Object.entries(DEFAULTS)) if (view[key] === undefined) view[key] = structuredClone(value);
  return view as unknown as ViewState;
}
