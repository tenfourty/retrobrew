import type { TroubleSource } from '../feedback/schema';
import { COPY } from './banners';

/**
 * Whether a banner that already explains the trouble gets "Send feedback" as its second action: the lost network once the
 * latch has called the connection lost (after its delay), and a failed save. The error banner has it as its own action.
 */
export function bannerOffersFeedback(text: string, has: (source: TroubleSource) => boolean): boolean {
  if (text === COPY.noRelays) return has('connection');
  if (text === COPY.saveFailed) return has('save');
  return false;
}
