# Retrobrew

A free Lean Coffee board that runs entirely in your browser. There is no server, no account and no sign-up.

The facilitator creates a meeting and shares a link. Participants open it on their own phones or laptops, add topics, vote with dots, and discuss each topic on a timer, with a vote to keep going or move on when time is up. When the meeting ends, the facilitator copies the outcome as text.

Lives at **[retrobrew.app](https://retrobrew.app)**.

## How it works

- **The facilitator's browser tab is the host.** It keeps the meeting in IndexedDB, checks every command and is the only place the rules are applied. Its clock is the source of truth for timers.
- **Participants connect to the host directly** over WebRTC ([Trystero](https://github.com/dmotz/trystero)), using Nostr relays only to find each other.
- **If a direct connection cannot form,** signed and end-to-end-encrypted Nostr events carry the same messages through public relays. The share link holds the key, and the relays see only ciphertext.
- **Nothing else is contacted.** The relays and STUN servers in `src/config.ts` are the only third-party hosts, and `npm run check:assets` fails a build that loads anything else.
- **If the facilitator's tab closes,** the meeting pauses until they open it again in the same browser. A backup file can be saved and restored.

The details are in [docs/product/](docs/product/README.md) (rules, screens, sync protocol) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Run it

You need Node 22 or later and Linux or macOS (on Windows, use WSL).

```sh
npm install
npm run dev      # landing page at http://localhost:5173/, guide at /lean-coffee/, app at /app/
npm test         # unit and integration tests (Vitest)
npm run build    # type-checks and builds static files into dist/
```

`dist/` is a static site: serve it from any web server. `Dockerfile` and `deploy/` build an nginx image with the security headers the app expects. See [AGENTS.md](AGENTS.md) for every command, including the browser tests.

## Contribute

Issues and pull requests are welcome. Read [AGENTS.md](AGENTS.md) first: it has the code map, the design rules and the testing conventions. In short:

- Behaviour is specified in `docs/product/`. Change the spec and the code together.
- Write the failing test first.
- Use conventional commits, one concern each.
- Use British English in docs, comments and user-facing text.

## Licence

[MIT](LICENSE).
