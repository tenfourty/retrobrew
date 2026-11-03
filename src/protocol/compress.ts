import { concatBytes, type Bytes } from '../crypto/bytes';

// Far above any real message (a full board is under 48 KB compressed), so a hostile frame can't exhaust memory.
export const MAX_INFLATED = 1_048_576;

async function collect(stream: ReadableStream<Uint8Array>, max: number): Promise<Bytes> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(...chunks);
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error('Inflated message too large');
    }
    chunks.push(value);
  }
}

// Writes straight into the transform and reads its output at the same time (so a large input can't stall on
// backpressure), rather than going through a Blob stream, which costs about 0.6 ms a call on the host's main thread.
function transform(data: Bytes, stream: CompressionStream | DecompressionStream, max: number): Promise<Bytes> {
  const writer = stream.writable.getWriter();
  const output = collect(stream.readable, max);
  // A write or close that fails (corrupt input, or the reader gave up) surfaces through the reader; don't leave it unhandled.
  writer.write(data).catch(() => undefined);
  writer.close().catch(() => undefined);
  return output;
}

export function deflate(data: Bytes): Promise<Bytes> {
  return transform(data, new CompressionStream('deflate'), Number.POSITIVE_INFINITY);
}

export function inflate(data: Bytes, max = MAX_INFLATED): Promise<Bytes> {
  return transform(data, new DecompressionStream('deflate'), max);
}
