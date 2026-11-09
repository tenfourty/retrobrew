import type { ReportPage } from '../feedback/schema';

/** The pages that link to the app's feedback sheet, named in the fragment as `#feedback=landing` or `#feedback=guide`. */
export type ArrivalFrom = Extract<ReportPage, 'landing' | 'guide'>;

export interface Arrival { from: ArrivalFrom | null }

/**
 * Reads `#feedback`, `#feedback=landing` and `#feedback=guide`. Any other fragment is not ours and gives null, so board
 * links (`b=`) and the start links are untouched. The fragment never reaches a server.
 */
export function parseFeedbackHash(hash: string): Arrival | null {
  const match = /^#feedback(?:=(landing|guide))?$/.exec(hash);
  if (!match) return null;
  return { from: (match[1] as ArrivalFrom | undefined) ?? null };
}
