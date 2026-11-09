// Entry point: reads the environment, starts the public and the internal listeners and the hourly sweep.
// Run with `node feedback/main.ts` (Node 22 strips the types).
import { createServer, type Server } from 'node:http';
import { loadConfig, type Config } from './config.ts';
import { createLimiter } from './limits.ts';
import { createLogger, type Logger } from './log.ts';
import { createSealer } from './seal.ts';
import { createService } from './service.ts';
import { createStore } from './store.ts';

const HOUR = 3600_000;

export interface Running {
  servers: Server[];
  stop(): Promise<void>;
}

/** After start-up, a request-scoped error is logged as a code and the service keeps serving. */
export function guardProcess(target: { on(event: 'uncaughtException' | 'unhandledRejection', handler: () => void): unknown }, log: Logger): void {
  target.on('uncaughtException', () => log({ outcome: 'error' }));
  target.on('unhandledRejection', () => log({ outcome: 'error' }));
}

/** Builds the service from a config and starts listening. Port 0 picks a free port (the tests use it). */
export async function start(config: Config, log: Logger, now: () => number = Date.now): Promise<Running & { ports: { public: number; internal: number } }> {
  const store = createStore({ dir: config.inboxDir, now, maxRecords: config.maxRecords, maxBytes: config.maxBytes, retentionMs: config.retentionMs });
  const sealer = await createSealer(config.kid, config.publicKey);
  const service = createService({ config, store, sealer, limiter: createLimiter(now), now, log });

  const configure = (server: Server): Server => {
    server.headersTimeout = config.headersTimeoutMs;
    server.requestTimeout = config.bodyTimeoutMs + config.headersTimeoutMs;
    // The timeouts are checked on this interval; the default (30 s) would let them overrun by far.
    (server as Server & { connectionsCheckingInterval: number }).connectionsCheckingInterval = 1000;
    server.keepAliveTimeout = 5000;
    return server;
  };
  const publicServer = configure(createServer(service.publicHandler));
  publicServer.maxConnections = config.maxConnections;
  const internalServer = configure(createServer(service.internalHandler));
  const listen = (server: Server, port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve((server.address() as { port: number }).port));
    });
  const ports = { public: await listen(publicServer, config.port), internal: await listen(internalServer, config.internalPort) };

  await service.sweep();
  const timer = setInterval(() => void service.sweep().catch(() => log({ outcome: 'error' })), HOUR);
  timer.unref();
  log({ outcome: 'started' });

  return {
    servers: [publicServer, internalServer],
    ports,
    async stop() {
      clearInterval(timer);
      await Promise.all([publicServer, internalServer].map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); })));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = createLogger((line) => process.stdout.write(line + '\n'), Date.now);
  try {
    const running = await start(loadConfig(process.env), log);
    const shutdown = (): void => void running.stop().then(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch {
    // Only a code: a configuration error names a variable, but a failed listen could carry an address.
    log({ outcome: 'error' });
    process.exit(1);
  }
  guardProcess(process, log);
}
