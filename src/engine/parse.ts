import type { Command } from './types';

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isId = (x: unknown): x is number => Number.isInteger(x);
// Numbers whose allowed values are a rule (allowances, timeboxes) are only checked for type here,
// so the engine can refuse a wrong value with its own message.
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isOptionalBool = (x: unknown): x is boolean | undefined => x === undefined || typeof x === 'boolean';

export function parseCommand(x: unknown): Command | null {
  if (!isRecord(x)) return null;
  switch (x.type) {
    case 'join':
      return typeof x.name === 'string' ? { type: 'join', name: x.name } : null;
    case 'addTopic':
      return typeof x.text === 'string' ? { type: 'addTopic', text: x.text } : null;
    case 'editTopic':
      return isId(x.topicId) && typeof x.text === 'string' ? { type: 'editTopic', topicId: x.topicId, text: x.text } : null;
    case 'deleteTopic':
      return isId(x.topicId) ? { type: 'deleteTopic', topicId: x.topicId } : null;
    case 'addVote':
      return isId(x.topicId) ? { type: 'addVote', topicId: x.topicId } : null;
    case 'removeVote':
      return isId(x.topicId) ? { type: 'removeVote', topicId: x.topicId } : null;
    case 'raiseAllowance':
      return isNum(x.votes) ? { type: 'raiseAllowance', votes: x.votes } : null;
    case 'clearVotes':
      return { type: 'clearVotes' };
    case 'setShowVotes':
      return typeof x.value === 'boolean' ? { type: 'setShowVotes', value: x.value } : null;
    case 'startDiscussion':
    case 'backToTopics':
    case 'endMeeting':
    case 'reopenMeeting':
      return { type: x.type };
    case 'discussTopic':
    case 'restartTimer': {
      if (!isId(x.topicId) || !isNum(x.minutes) || !isOptionalBool(x.realMinutes)) return null;
      const timed = { type: x.type, topicId: x.topicId, minutes: x.minutes };
      return x.realMinutes === undefined ? timed : { ...timed, realMinutes: x.realMinutes };
    }
    case 'stopTimer':
    case 'returnTopic':
    case 'finishTopic':
      return isId(x.topicId) ? { type: x.type, topicId: x.topicId } : null;
    case 'voteToContinue':
      return isId(x.topicId) && isId(x.round) && typeof x.choice === 'string'
        ? { type: 'voteToContinue', topicId: x.topicId, round: x.round, choice: x.choice } : null;
    case 'extendTopic':
      return isId(x.topicId) && isId(x.round) && isNum(x.minutes)
        ? { type: 'extendTopic', topicId: x.topicId, round: x.round, minutes: x.minutes } : null;
    case 'setTimerSound':
      return typeof x.sound === 'string' ? { type: 'setTimerSound', sound: x.sound } : null;
    default:
      return null;
  }
}
