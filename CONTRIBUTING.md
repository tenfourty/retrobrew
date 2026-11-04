# Contributing to Retrobrew

Retrobrew is a free, browser-only Lean Coffee board. The facilitator's browser tab is the host and keeps the board in IndexedDB. Participants join from their own devices through a share link and sync with the host over WebRTC (Trystero), with end-to-end-encrypted Nostr relay events as the fallback. There is no server, no account and no backend.

This file is the contributor guide.

## Read first

| What | Where |
| --- | --- |
| Product behaviour (the source of truth) | `docs/product/README.md` and the files beside it |
| Sync protocol | `docs/product/sync-protocol.md` |
| Architecture | `ARCHITECTURE.md` |
| Visual design | `design/README.md`, then `design/system/`, before any UI work |
| Landing page and guide | `docs/product/landing.md` |

## Code map

| Path | Holds |
| --- | --- |
| `src/engine/` | Board rules: commands, limits, discussion and timer logic, invariants |
| `src/protocol/` | Wire format: envelopes, compression, bundles, size meter, messages, versions |
| `src/session/` | Host and participant sessions: peers, tabs, outbox, pacer, refresh, scheduler |
| `src/transport/` | WebRTC (Trystero), Nostr relay and the hybrid of both |
| `src/crypto/` | Signing, sealing and hashing (WebCrypto) |
| `src/store/` | IndexedDB board store, export and import |
| `src/clock/` | The host's monotonic clock |
| `src/app/` | Controllers, banners, start-up, and the Preact views (`src/app/views/`) |
| `src/ui/` | Shared UI components, formatting and the mode switch |
| `index.html`, `lean-coffee/`, `src/site/` | The hand-written landing page and guide, and their stylesheet (no app code) |
| `src/config.ts` | The only Nostr relays and STUN servers the product may contact |
| `e2e/` | Playwright browser battery and its helpers |
| `deploy/`, `Dockerfile` | The static site image: nginx config and security headers |

## Design rules

- **No third-party requests** except the relays and STUN servers in `src/config.ts`. `npm run check:assets` enforces it on every build.
- **No server, no accounts, no cloud service.**
- **The facilitator's tab is the authority:** participants send commands; the host validates them and broadcasts signed, sealed state. The host's clock is the source of truth for timers.
- **Follow the product docs' rules:** columns `ideas` → `toDiscuss` → `discussing` → `discussed`, one topic in Discussing at a time, timeboxes of 1, 2, 3, 4, 5, 10, 15, 20 and 30 minutes, extensions of 1 to 5 minutes, merged topics summing their votes, fractional `position`.
- **Protocol changes are versioned.** A wire change goes through `src/protocol/version.ts` and `docs/product/sync-protocol.md` together.
- **Build UI from the design system:** its tokens and `--rb-*` roles, never hard-coded colours, fonts or radii. Keep both modes, Business and Party, working.

## Setup

- Node 22 or later; `npm install`. Linux or macOS (on Windows, WSL).
- Rootless podman for the browser battery's local Nostr relay (not needed with `E2E_RELAY_UPSTREAM`, see below). Docker isn't needed.
- If Chromium is missing: `npx playwright install chromium`.
- Run every command from the repository root.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Serves `/` (landing), `/lean-coffee/` (guide) and `/app/` at http://localhost:5173/ |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run build` | Type-checks and builds `dist/`, including `/version.txt` |
| `npm run check:assets` | Fails if the build loads anything from a third-party host, lacks `/version.txt`, or carries a browser-battery hook (`__rbRelayHealth`, `__rbDirectPeers`, `rb-e2e-force`, the forced start-failure message) |
| `RETROBREW_LAUNCH=1 npm run check:assets` | Also fails on the bare `https://github.com/` source and licence links |
| `npm run test:e2e` | The Playwright battery (projects `local`, then `local-restart`, which restarts the relay), a few minutes |
| `npm run test:e2e:public` | Tests tagged `@public`, against the real public relays (needs network). `E2E_BASE_URL` targets a deployment; `E2E_APP_PATH` if the app is not at `/app/` |
| `npm run test:soak` | The soak test (`e2e/soak/`), on demand: a facilitator and five participants in a rehearsal meeting for 50 minutes, checking that every board agrees after each cycle and that heap, open sockets and wake lock calls stay flat. `E2E_SOAK_MINUTES=3` shortens it (1 to 70) |
| `npm run gallery` | The gallery project (`e2e/gallery/`), on demand: every meeting screen at phone (360 px) and desktop (1280 px) widths in all four themes, into `gallery/` (git-ignored; `GALLERY_DIR` changes the folder) with an `index.html` to browse them |
| `npm run check:e2e` | Type-checks `e2e/` and `playwright.config.ts` |

- `test:e2e` builds into `dist-e2e/` with `vite build --mode e2e`, serves it on http://localhost:4180/, and starts a local nostr-rs-relay with podman (pinned in `e2e/relay/settings.ts`) on 127.0.0.1:17777, with a rate-limited relay in front on 127.0.0.1:17778.
- With `E2E_RELAY_UPSTREAM=host:port` global setup starts no podman container: it forwards 127.0.0.1:17777 and [::1]:17777 to that relay, still checks its NIP-11 name and still starts the rate-limited proxy. Leave it unset on a developer machine.
- One `test:e2e` run per machine: a lock file makes a second run stop at once, naming the first. A crashed run's lock and container are replaced automatically.
- `VITE_RELAYS` (comma-separated `ws://` or `wss://` URLs) replaces the relays in `--mode e2e` builds only; `check:assets` fails if any other build contains a localhost relay.
- GitHub Actions (`.github/workflows/`) run in CI: `e2e.yml` runs the unit tests, the build, `check:assets` and the browser battery on every push to `main` and to `ci/e2e*` branches, and on every pull request into `main` (fork pull requests too: read-only token, no secrets; a newer push to a pull request cancels its older run; a failed run uploads the artifact `e2e-failure`, kept 5 days); `soak.yml` and `gallery.yml` run on demand only, by manual dispatch or a push to a `ci/soak*` or `ci/gallery*` branch (a soak push runs 3 minutes unless the branch name ends in `-full` or `-<n>m`; the dispatch input `minutes` takes 1 to 70). All three use the pinned Playwright image on a GitHub-hosted runner and start the relay as a container named `retrobrew-e2e-relay` from the checkout's `e2e/relay/` files. They need no secrets. `.forgejo/workflows/site.yml` builds the site image and is the only workflow left in `.forgejo/`; everything specific to one installation is a CI variable (`vars.*`) listed in its header.
- IMPORTANT: never point a test runner's root or discovery directory outside the repo (no `vitest --root /` or `--root ~`): it walks the whole filesystem. Put scratch tests inside the repo.

## Testing

- Test first: write the failing test, then the code.
- Engine rules first: vote limits, column transitions, one topic in Discussing, timer expiry and vote to continue, merge and unmerge totals.
- Small, deterministic fixtures; fake timers over real waits. Use rehearsal boards (`withRehearsal(url)`; a timebox minute lasts 10 seconds) rather than real-time waits.
- Browser tests give each person their own browser context and run against the local relay. Tag a test `{ tag: '@public' }` to add it to the public smoke run.
- Helpers live in `e2e/helpers.ts` (read its doc comments). The ones to know:
  - `installNetworkHooks(context)` first, before opening pages the helpers act on;
  - `hostMeeting(page, name, meetingName?, { rehearsal? })` creates a meeting, closes the "Invite people" dialog and returns the share link; `joinMeeting` joins one;
  - `freezePage` / `resumePage` simulate a phone locking and unlocking; `blockRelay` / `unblockRelay` cut a relay; `useRateLimitedRelay(context, ip?)` routes through the rate-limited relay;
  - `expectNoA11yViolations(page)` fails on serious or critical axe violations;
  - `forceSignals(page, forced)` forces banner signals or the facilitator's starting and failed states (`--mode e2e` builds only, behind `import.meta.env.MODE === 'e2e'`; `check:assets` fails any other build that carries the hooks);
  - `banner(page, text)` is the visible banner holding some text; use it, not `getByText`, because the page's live region repeats banner text;
  - `addTopic`, `discussTopic`, `timeUpSheet`, `outcomeLine`, `openPeople` and `connectionLine` drive the board;
  - for failure output: `recordWsFrames(page)` then `describeSends` / `countSends`, and `relayHealthOf(page)`.
- Session tests (`src/session/`) step a `FakeScheduler` and use `settle()` from `src/test/settle.ts`, which waits for in-flight WebCrypto and compression, between steps; never a real `sleep()`. Run a file with `RETROBREW_SLOW_CRYPTO=20` (a random real delay of up to 20 ms on each WebCrypto call) to expose a test that still guesses how long work takes. Vitest's default timeout is 30 s (a CI machine can be 2 to 3 times slower than a developer machine); a test that needs more sets its own.

## Conventions

- British English in docs, comments and user-facing strings. Match UI copy to the wording in `docs/product/`.
- Clarity over cleverness: meaningful names, guard clauses, shallow nesting. Don't reformat code you aren't changing.
- Conventional commits (`feat(voting): enforce votes-per-person limit`), one concern each.
- Never commit secrets. The share link must expose nothing beyond the board it is for.

## Docs are part of done

A change is not done until every doc its readers use describes it, including its limits:

- people using the app: the in-app copy, the landing page and the guide (`docs/product/landing.md`);
- behaviour and protocol: `docs/product/`;
- structure and rationale: `ARCHITECTURE.md`;
- contributors: `README.md`, this file.
