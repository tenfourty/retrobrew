import { isFacilitator } from './board';
import {
  discussTopic, extendTopic, finishTopic, restartTimer, returnTopic, setTimerSound, stopTimer, undoMoveOn, voteToContinue,
} from './discussion';
import { join } from './people';
import { backToTopics, endMeeting, reopenMeeting, startDiscussion } from './phases';
import { refuse } from './result';
import { addTopic, deleteTopic, editTopic } from './topics';
import type { BoardState, Command, Result } from './types';
import { raiseAllowance, removeVote, clearVotes, setShowVotes, addVote } from './votes';

// Commands whose sender needs an explicit owner or facilitator role.
const FACILITATOR_ONLY: ReadonlySet<string> = new Set([
  'raiseAllowance', 'clearVotes', 'setShowVotes', 'startDiscussion', 'backToTopics', 'endMeeting', 'reopenMeeting',
  'discussTopic', 'stopTimer', 'restartTimer', 'returnTopic', 'extendTopic', 'finishTopic', 'undoMoveOn', 'setTimerSound',
]);

// The only commands an ended meeting accepts.
const ALLOWED_WHEN_ENDED: ReadonlySet<string> = new Set(['join', 'reopenMeeting']);

// Checks every command in the order set out in docs/product/lean-coffee-rules.md and stops at the first failure: joined,
// facilitator, not ended, then the command's own preconditions. (Well-formedness is
// checked by parseCommand before a command gets here.) It never changes the state it is given.
export function apply(state: BoardState, actorId: string, cmd: Command, now: number): Result {
  if (cmd.type === 'join') return join(state, actorId, cmd);
  if (!state.attendees[actorId]) return refuse('notAttendee');
  if (FACILITATOR_ONLY.has(cmd.type) && !isFacilitator(state, actorId)) return refuse('facilitatorOnly');
  if (state.phase === 'ended' && !ALLOWED_WHEN_ENDED.has(cmd.type)) return refuse('ended');

  switch (cmd.type) {
    case 'addTopic': return addTopic(state, actorId, cmd);
    case 'editTopic': return editTopic(state, actorId, cmd);
    case 'deleteTopic': return deleteTopic(state, actorId, cmd);
    case 'addVote': return addVote(state, actorId, cmd);
    case 'removeVote': return removeVote(state, actorId, cmd);
    case 'raiseAllowance': return raiseAllowance(state, cmd);
    case 'clearVotes': return clearVotes(state);
    case 'setShowVotes': return setShowVotes(state, cmd);
    case 'startDiscussion': return startDiscussion(state);
    case 'backToTopics': return backToTopics(state);
    case 'endMeeting': return endMeeting(state, now);
    case 'reopenMeeting': return reopenMeeting(state);
    case 'discussTopic': return discussTopic(state, cmd, now);
    case 'stopTimer': return stopTimer(state, cmd);
    case 'restartTimer': return restartTimer(state, cmd, now);
    case 'returnTopic': return returnTopic(state, cmd);
    case 'finishTopic': return finishTopic(state, cmd);
    case 'undoMoveOn': return undoMoveOn(state, cmd);
    case 'voteToContinue': return voteToContinue(state, actorId, cmd);
    case 'extendTopic': return extendTopic(state, cmd, now);
    case 'setTimerSound': return setTimerSound(state, cmd);
    default: {
      // Unreachable for a parsed command. Refused rather than thrown, so it can't block the commands after it.
      const unknown: never = cmd;
      void unknown;
      return refuse('badCommand');
    }
  }
}
