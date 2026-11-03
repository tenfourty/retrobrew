import type {
  BoardState, PersonalView, Role, SharedView, Topic, TopicView, ViewContext, ViewState, VoteView,
} from './types';

// Every view is built for its viewer on the host. Hidden data must never leave the host,
// because every participant can read their own decrypted traffic.

function roleOf(state: BoardState, viewerId: string): Role {
  // Someone with no attendee entry is a guest: facilitator rights need an explicit role.
  return state.attendees[viewerId]?.role ?? 'guest';
}

// Show votes off hides counts on Ideas topics, in the topics phase only, for everyone.
function countHidden(state: BoardState, topic: Topic): boolean {
  return !state.showVotes && state.phase === 'topics' && topic.column === 'ideas';
}

function dotsBy(topic: Topic, viewerId: string): number {
  return topic.voters.filter((id) => id === viewerId).length;
}

// A connected peer whose join is pending or refused is not an attendee, so is never listed.
function onlineAttendees(state: BoardState, ctx: ViewContext): string[] {
  return (ctx.online ?? []).filter((id) => state.attendees[id] !== undefined);
}

function turnout(state: BoardState, online: string[]): { voted: number; here: number } {
  const voted = state.continueVote?.voters.length ?? 0;
  return { voted, here: Math.max(voted, online.length) };
}

function seesTotals(state: BoardState, viewerId: string): boolean {
  return roleOf(state, viewerId) !== 'guest' || (state.continueVote?.voters.includes(viewerId) ?? false);
}

export function redactFor(state: BoardState, viewerId: string, ctx: ViewContext = {}): ViewState {
  const online = onlineAttendees(state, ctx);
  const topics = state.topics.map((t): TopicView => {
    const view: TopicView = {
      topicId: t.topicId, text: t.text, column: t.column, position: t.position, authorId: t.authorId,
      mine: dotsBy(t, viewerId),
    };
    if (!countHidden(state, t)) view.votes = t.voters.length;
    return view;
  });
  let vote: VoteView | null = null;
  if (state.continueVote) {
    const cv = state.continueVote;
    vote = { topicId: cv.topicId, round: cv.round, voted: cv.voters.includes(viewerId), turnout: turnout(state, online) };
    if (seesTotals(state, viewerId)) vote.totals = { ...cv.totals };
  }
  const view: ViewState = {
    boardId: state.boardId,
    boardName: state.boardName,
    phase: state.phase,
    voteAllowance: state.voteAllowance,
    showVotes: state.showVotes,
    rehearsal: state.rehearsal,
    timerSound: state.timerSound,
    endedAt: state.endedAt,
    discussedOrder: [...state.discussedOrder],
    topics,
    attendees: structuredClone(state.attendees),
    online,
    timer: state.timer ? { ...state.timer } : null,
    vote,
    role: roleOf(state, viewerId),
    acks: { ...(ctx.acks ?? {}) },
    rejects: structuredClone(ctx.rejects ?? {}),
  };
  if (ctx.joinRefused !== undefined) view.joinRefused = ctx.joinRefused;
  return view;
}

// The viewer-neutral part of every view: what a relay bundle sends once for everyone.
export function sharedView(state: BoardState, ctx: ViewContext = {}): SharedView {
  const online = onlineAttendees(state, ctx);
  const cv = state.continueVote;
  return {
    boardId: state.boardId,
    boardName: state.boardName,
    phase: state.phase,
    voteAllowance: state.voteAllowance,
    showVotes: state.showVotes,
    rehearsal: state.rehearsal,
    timerSound: state.timerSound,
    endedAt: state.endedAt,
    discussedOrder: [...state.discussedOrder],
    topics: state.topics.map((t) => {
      const shared: SharedView['topics'][number] = {
        topicId: t.topicId, text: t.text, column: t.column, position: t.position, authorId: t.authorId,
      };
      if (!countHidden(state, t)) shared.votes = t.voters.length;
      return shared;
    }),
    attendees: structuredClone(state.attendees),
    online,
    timer: state.timer ? { ...state.timer } : null,
    vote: cv ? { topicId: cv.topicId, round: cv.round, turnout: turnout(state, online) } : null,
  };
}

// The parts of a view that differ per viewer: what a relay bundle seals for each person.
export function splitView(state: BoardState, viewerId: string, ctx: ViewContext = {}): { shared: SharedView; personal: PersonalView } {
  const mine: Record<string, number> = {};
  for (const t of state.topics) {
    const dots = dotsBy(t, viewerId);
    if (dots > 0) mine[String(t.topicId)] = dots;
  }
  const cv = state.continueVote;
  const personal: PersonalView = {
    you: viewerId,
    role: roleOf(state, viewerId),
    mine,
    voted: cv?.voters.includes(viewerId) ?? false,
    acks: { ...(ctx.acks ?? {}) },
    rejects: structuredClone(ctx.rejects ?? {}),
  };
  if (cv && seesTotals(state, viewerId)) personal.totals = { ...cv.totals };
  if (ctx.joinRefused !== undefined) personal.joinRefused = ctx.joinRefused;
  return { shared: sharedView(state, ctx), personal };
}

// A participant's view from the shared part and their own entry: exactly what redactFor builds.
export function mergeView(shared: SharedView, personal: PersonalView): ViewState {
  const view: ViewState = {
    ...structuredClone(shared),
    topics: shared.topics.map((t) => ({ ...t, mine: personal.mine[String(t.topicId)] ?? 0 })),
    vote: null,
    role: personal.role,
    acks: { ...personal.acks },
    rejects: structuredClone(personal.rejects),
  };
  if (shared.vote) {
    view.vote = { ...structuredClone(shared.vote), voted: personal.voted };
    if (personal.totals) view.vote.totals = { ...personal.totals };
  }
  if (personal.joinRefused !== undefined) view.joinRefused = personal.joinRefused;
  return view;
}

// Votes the viewer has left: the allowance minus every dot of theirs, in any column.
export function viewVotesLeft(view: ViewState): number {
  const used = view.topics.reduce((n, t) => n + t.mine, 0);
  return Math.max(0, view.voteAllowance - used);
}
