// One JSON line per event, made of codes and numbers only. The type below is the whole vocabulary: there is no field
// that can hold a string from a request, so a body fragment, an address or an exception's text cannot be logged.

export const OUTCOMES = [
  'accepted', 'invalid', 'link', 'limited_client', 'limited_global', 'too_large', 'evicted', 'duplicate', 'forbidden',
  'method', 'notfound', 'unsupported', 'busy', 'timeout', 'unauthorized', 'pulled', 'confirmed', 'swept', 'error', 'started', 'unattributed',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const SIZES = ['<1k', '<4k', '<16k', '16k+'] as const;
export const LATENCIES = ['<10ms', '<100ms', '<1s', '1s+'] as const;

export interface LogEntry {
  outcome: Outcome;
  /** Request size bucket, for requests. */
  size?: (typeof SIZES)[number];
  latency?: (typeof LATENCIES)[number];
  /** A count: records evicted or swept. */
  n?: number;
}

export type Logger = (entry: LogEntry) => void;

export const sizeBucket = (bytes: number): (typeof SIZES)[number] =>
  bytes < 1024 ? '<1k' : bytes < 4096 ? '<4k' : bytes < 16_384 ? '<16k' : '16k+';

export const latencyBucket = (ms: number): (typeof LATENCIES)[number] =>
  ms < 10 ? '<10ms' : ms < 100 ? '<100ms' : ms < 1000 ? '<1s' : '1s+';

/** The sink writes whole lines; `t` is the UTC minute, so a line carries no finer timing than the buckets. */
export function createLogger(write: (line: string) => void, now: () => number): Logger {
  return (entry) => {
    const t = new Date(now()).toISOString().slice(0, 16) + 'Z';
    write(JSON.stringify({ t, ...entry }));
  };
}

/** What every line must match (the tests assert it for all lines they collect). */
export const LOG_LINE =
  /^\{"t":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z","outcome":"[a-z_]+"(?:,"size":"(?:<1k|<4k|<16k|16k\+)")?(?:,"latency":"(?:<10ms|<100ms|<1s|1s\+)")?(?:,"n":\d{1,7})?\}$/;
