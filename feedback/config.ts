// The service's configuration, read once from the environment. Nothing here is secret: the reader's public key and the
// hash of its pull token. Either may be given inline or as a file path (`..._FILE`), as a mounted secret.
import { readFileSync } from 'node:fs';

export interface Config {
  port: number;
  internalPort: number;
  inboxDir: string;
  allowedOrigin: string;
  /** The key id and the reader's public key (uncompressed P-256 point, 65 bytes) the endpoint seals to. */
  kid: string;
  publicKey: Buffer;
  /** SHA-256 of the reader's bearer token, 32 bytes. */
  pullTokenHash: Buffer;
  /** The header the trusted ingress puts the client address in. */
  clientIpHeader: string;
  maxRecords: number;
  maxBytes: number;
  retentionMs: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  maxConcurrent: number;
  /** Open sockets the public listener accepts, so half-open connections cannot pile up without limit. */
  maxConnections: number;
}

export const DEFAULTS = {
  port: 8080,
  internalPort: 8081,
  allowedOrigin: 'https://retrobrew.app',
  clientIpHeader: 'x-real-ip',
  maxRecords: 3000,
  maxBytes: 30 * 1024 * 1024,
  retentionMs: 30 * 24 * 3600 * 1000,
  headersTimeoutMs: 5000,
  bodyTimeoutMs: 5000,
  maxConcurrent: 64,
  maxConnections: 256,
} as const;

export const KID = /^[A-Za-z0-9._-]{1,32}$/;

type Env = Record<string, string | undefined>;

function value(env: Env, name: string): string {
  const file = env[`${name}_FILE`];
  const raw = file ? readFileSync(file, 'utf8') : env[name];
  if (!raw || !raw.trim()) throw new Error(`missing ${name}`);
  return raw.trim();
}

function number(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad ${name}`);
  return n;
}

/** Throws (with the variable's name, never its value) when anything required is missing or malformed. */
export function loadConfig(env: Env): Config {
  const kid = value(env, 'FEEDBACK_SEAL_KID');
  if (!KID.test(kid)) throw new Error('bad FEEDBACK_SEAL_KID');
  const publicKey = Buffer.from(value(env, 'FEEDBACK_SEAL_PUBLIC_KEY'), 'base64url');
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('bad FEEDBACK_SEAL_PUBLIC_KEY');
  const hashText = value(env, 'FEEDBACK_PULL_TOKEN_SHA256');
  if (!/^[0-9a-fA-F]{64}$/.test(hashText)) throw new Error('bad FEEDBACK_PULL_TOKEN_SHA256');
  const config: Config = {
    port: number(env, 'FEEDBACK_PORT', DEFAULTS.port),
    internalPort: number(env, 'FEEDBACK_INTERNAL_PORT', DEFAULTS.internalPort),
    inboxDir: env.FEEDBACK_INBOX_DIR || '/data/inbox',
    allowedOrigin: env.FEEDBACK_ALLOWED_ORIGIN || DEFAULTS.allowedOrigin,
    kid,
    publicKey,
    pullTokenHash: Buffer.from(hashText, 'hex'),
    clientIpHeader: (env.FEEDBACK_CLIENT_IP_HEADER || DEFAULTS.clientIpHeader).toLowerCase(),
    maxRecords: number(env, 'FEEDBACK_MAX_RECORDS', DEFAULTS.maxRecords),
    maxBytes: number(env, 'FEEDBACK_MAX_BYTES', DEFAULTS.maxBytes),
    retentionMs: DEFAULTS.retentionMs,
    headersTimeoutMs: DEFAULTS.headersTimeoutMs,
    bodyTimeoutMs: DEFAULTS.bodyTimeoutMs,
    maxConcurrent: DEFAULTS.maxConcurrent,
    maxConnections: DEFAULTS.maxConnections,
  };
  if (config.port === config.internalPort) throw new Error('FEEDBACK_PORT and FEEDBACK_INTERNAL_PORT must differ');
  return config;
}
