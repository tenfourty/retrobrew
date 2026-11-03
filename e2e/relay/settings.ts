// The local relays for the browser battery. The ports are unusual on purpose, so they don't collide with a relay
// a developer already runs (strfry's default is 7777).
export const LOCAL_RELAY_PORT = 17777;
export const RATE_LIMITED_RELAY_PORT = 17778;
export const LOCAL_RELAY_URL = `ws://127.0.0.1:${LOCAL_RELAY_PORT}`;
// The same relay under a second name. The test build lists both, so a test can block one relay and then all of them.
export const LOCAL_RELAY_ALIAS_URL = `ws://localhost:${LOCAL_RELAY_PORT}`;
export const LOCAL_RELAY_URLS = [LOCAL_RELAY_URL, LOCAL_RELAY_ALIAS_URL];
export const RATE_LIMITED_RELAY_URL = `ws://127.0.0.1:${RATE_LIMITED_RELAY_PORT}`;

// nostr-rs-relay 0.10.0, the `latest` tag on 6 Oct 2026 (built 22 May 2026), pinned by digest. linux/amd64 only.
export const RELAY_IMAGE = 'docker.io/scsibug/nostr-rs-relay@sha256:48d54c2d2781577cf3ed2951112f0953dc2c5e7c9d2ea20c64e8c0fa37d16e4d';
export const RELAY_CONTAINER = 'retrobrew-e2e-relay';
// The label that records which test run started the container (its run token, see run-lock.ts).
export const OWNER_LABEL = 'retrobrew.e2e.run';
// The relay's NIP-11 name, from nostr-rs-relay.toml. A relay that answers with another name ignored its config.
export const RELAY_NAME = 'retrobrew e2e';

// The rate-limited relay behaves like a popular public relay we probed: it refuses
// events over the limit with "rate-limited:", then disconnects a client that keeps going and bans its address for a while.
// Two buckets apply to every event: one per connection, and one per client address. Every browser context connects
// from 127.0.0.1, so the address is the connection's remote address plus the `ip` query parameter that
// useRateLimitedRelay(context, ip) adds: contexts given the same `ip` share a bucket, as people on one Wi-Fi do.
// The per-address limit is an assumption; public relays don't publish theirs.
export const RATE_LIMIT = {
  connection: { eventsPerSecond: 3, burst: 6 },
  address: { eventsPerSecond: 10, burst: 20 },
  banAfter: 10,
  banSeconds: 60,
};
