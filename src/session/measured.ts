import { apply } from '../engine/apply';
import { REFRESH_CAP_BYTES, type Measure } from '../engine/limits';
import { refuse } from '../engine/result';
import type { BoardState, Command, Result } from '../engine/types';

// apply, then the size cap: a change the engine marks as growing is measured (asynchronously, with the size meter's
// upper bound) and refused with its key if the full refresh it would make is over 44 KB.
export async function measuredApply(state: BoardState, actorId: string, cmd: Command, now: number, measure: Measure): Promise<Result> {
  const result = apply(state, actorId, cmd, now);
  if (!result.ok || !result.changed || !result.grows) return result;
  // A measure that throws or rejects counts as too big: refuse the growth rather than fail the change.
  let bytes = Number.POSITIVE_INFINITY;
  try {
    bytes = await measure(result.state);
  } catch (err) {
    console.warn('Size measure failed; refusing the change', err);
  }
  return bytes <= REFRESH_CAP_BYTES ? result : refuse(result.grows);
}
