// Relays that were tried. PUBLIC_RELAYS is the subset that delivered reliably.
export const CANDIDATE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://relay.nostr.net',
];

// Chosen by probing each candidate on 30 Sep 2026: every test event was delivered, at 512 B and at 16 KB, in both runs.
// Some of the others rate-limit or ban a client that sends a few events a second, filter keys by reputation, or time out.
export const PUBLIC_RELAYS: string[] = [
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://relay.nostr.net',
];

// The browser battery builds with `vite build --mode e2e` and VITE_RELAYS (comma-separated) to use a local relay.
// Every other mode ignores VITE_RELAYS, so a stray variable can never point a real build at other relays.
export function relaysFor(env: { MODE?: string; VITE_RELAYS?: string } | undefined): string[] {
  if (env?.MODE !== 'e2e' || !env.VITE_RELAYS) return PUBLIC_RELAYS;
  const relays = env.VITE_RELAYS.split(',').map((relay) => relay.trim()).filter(Boolean);
  const invalid = relays.filter((relay) => !/^wss?:\/\/[^\s/]+/.test(relay));
  if (invalid.length) throw new Error(`VITE_RELAYS entries must be ws:// or wss:// URLs: ${invalid.join(', ')}`);
  return relays.length ? relays : PUBLIC_RELAYS;
}

// import.meta.env is undefined when Node runs this file directly.
export const DEFAULT_RELAYS: string[] = relaysFor(import.meta.env);

// STUN servers learn a participant's IP address and nothing else. Chosen explicitly, not left to library defaults.
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

// Ephemeral range (20000–29999): relays forward these events without storing them.
export const RELAY_EVENT_KIND = 20333;
