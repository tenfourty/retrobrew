import { WebSocket, WebSocketServer } from 'ws';

export interface Bucket {
  eventsPerSecond: number;
  burst: number;
}

export interface RateLimit {
  connection: Bucket;
  address: Bucket;
  banAfter: number;
  banSeconds: number;
}

export interface RateLimitProxy {
  close(): Promise<void>;
}

// A WebSocket proxy in front of the local relay that rate-limits EVENT messages as public relays do. Every event takes
// a token from its connection's bucket and from its client address's bucket. Over either limit, the proxy answers
// ["OK", id, false, "rate-limited: …"] instead of forwarding the event. After `banAfter` refusals it closes the
// connection with code 1008 and bans the address for `banSeconds`. nostr-rs-relay can't do any of this itself:
// its messages_per_sec only throttles stored events, and ephemeral events are never stored.
export async function startRateLimitProxy(o: { port: number; upstream: string; limit: RateLimit }): Promise<RateLimitProxy> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: o.port });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addressBuckets = new Map<string, TokenBucket>();
  const bannedUntil = new Map<string, number>();

  server.on('connection', (client, request) => {
    // Every test client connects from 127.0.0.1, so the `ip` query parameter stands in for different addresses.
    const ip = new URL(request.url ?? '/', 'ws://proxy').searchParams.get('ip') ?? '';
    const address = `${request.socket.remoteAddress ?? ''}|${ip}`;
    if ((bannedUntil.get(address) ?? 0) > Date.now()) {
      client.close(1008, 'rate-limited: banned');
      return;
    }
    if (!addressBuckets.has(address)) addressBuckets.set(address, new TokenBucket(o.limit.address));
    const addressBucket = addressBuckets.get(address)!;
    const connectionBucket = new TokenBucket(o.limit.connection);
    const upstream = new WebSocket(o.upstream);
    const waiting: string[] = [];
    let clientGone = false;
    let refusals = 0;

    upstream.on('open', () => {
      for (const message of waiting.splice(0)) upstream.send(message);
      // Events accepted before the client left still reach the relay, as they would have on a real one.
      if (clientGone) upstream.close();
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('close', () => client.close());
    upstream.on('error', () => client.terminate());
    client.on('close', () => {
      clientGone = true;
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
    // Events still waiting for the upstream to open are flushed by its open handler, which then closes it (clientGone is set by 'close').
    client.on('error', () => { if (waiting.length === 0) upstream.terminate(); });
    client.on('message', (data) => {
      // After the ban's close(1008) the socket is closing: forward nothing and don't count (or ban) again.
      if (client.readyState !== WebSocket.OPEN) return;
      const message = data.toString();
      const id = eventId(message);
      if (id !== undefined && !takeBoth(connectionBucket, addressBucket)) {
        refusals += 1;
        client.send(JSON.stringify(['OK', id, false, 'rate-limited: slow down']));
        if (refusals >= o.limit.banAfter) {
          bannedUntil.set(address, Date.now() + o.limit.banSeconds * 1000);
          client.close(1008, 'rate-limited: banned');
        }
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else waiting.push(message);
    });
  });
  return {
    close: () => new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(() => resolve());
    }),
  };
}

class TokenBucket {
  private tokens: number;
  private refilledAt = Date.now();

  constructor(private readonly limit: Bucket) {
    this.tokens = limit.burst;
  }

  available(): number {
    const now = Date.now();
    this.tokens = Math.min(this.limit.burst, this.tokens + ((now - this.refilledAt) / 1000) * this.limit.eventsPerSecond);
    this.refilledAt = now;
    return this.tokens;
  }

  take(): void {
    this.tokens -= 1;
  }
}

// Takes a token from both buckets, or from neither.
function takeBoth(a: TokenBucket, b: TokenBucket): boolean {
  if (a.available() < 1 || b.available() < 1) return false;
  a.take();
  b.take();
  return true;
}

// The event ID of an ["EVENT", event] message, or undefined for anything else (REQ, CLOSE, or not JSON).
function eventId(message: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!Array.isArray(parsed) || parsed[0] !== 'EVENT') return undefined;
    const event = parsed[1] as { id?: unknown } | undefined;
    return typeof event?.id === 'string' ? event.id : undefined;
  } catch {
    return undefined;
  }
}
