# Feedback

A person who hits a problem, or has an idea, can tell the owner from the page they are on, after reading exactly what will be sent. This document is the product spec for what the report holds and the limits it keeps.

Status: the report, its validator, error capture, the trouble latch and the send request are built in `src/feedback/`, and the endpoint service is built in `feedback/` (below). Nothing in the app uses the client code yet, and the endpoint is not deployed: there is no button, no sheet, and no build sends anything. Later changes add the screens and the reader, and update this document with the screens and copy.

## What leaves the device, and when

Nothing leaves until the person presses Send. There is no telemetry and no automatic report. Capturing an error only fills a small list in memory (the last three) and starts the trouble state; it sends nothing.

The request is one `POST /feedback` to the app's own origin with a JSON body. The person reads that body (as readable rows, with the exact JSON one tap away) before sending it, and the string they read is the string that is sent.

## The body

```
{ "v": 1, "kind": …, "message": …, "report": { … } | null, "contact": { "email": … } | null }
```

The endpoint rejects unknown keys, wrong types, patterns that do not match and over-long strings. It never repairs a body.

| Path | Value and limit |
| --- | --- |
| `v` | The number 1 |
| `kind` | `broke`, `idea` or `other`, from the picker |
| `message` | The person's words: NFC, newline kept, other control characters removed, 1 to 2,000 UTF-16 units, not empty after trimming |
| `contact` | `null`, or `{ email }`: the optional reply address (below). Outside `report` |
| `report` | `null` when the report could not be prepared (the message still goes), else the fields below |

### The report

| Field | Value and limit | Source |
| --- | --- | --- |
| `page` | `home`, `host`, `participant`, `state`, `landing` or `guide` | The view; `landing` and `guide` from the link that opened the sheet |
| `role` | `facilitator`, `participant` or `none` | The view |
| `phase` | `topics`, `discussing`, `ended` or `none` | The view |
| `theme`, `scheme` | `business` or `party`; `light` or `dark` | The mode switch and the colour scheme |
| `buildVersion` | `dev`, `unknown` or seven hex digits | The build (`__RB_REVISION__`, the first seven digits of `/version.txt`) |
| `liveVersion` | The same, or `null` | `/version.txt` fetched when the sheet opens (3 s limit), so a stale tab shows |
| `userAgent` | At most 200 characters | `navigator.userAgent` |
| `language` | `en`, `en-GB` form: two or three letters and an optional region | `navigator.language` |
| `viewport` | `{ w, h }`, rounded to 10, 0 to 9,990 | The window |
| `pixelRatio` | Rounded to 0.5, 0.5 to 8 | `devicePixelRatio` |
| `online` | Boolean | `navigator.onLine` |
| `capabilities` | `{ webrtc, wakeLock, storagePersisted }`, each true, false or `null` | Feature checks |
| `connection` | `connecting`, `connected`, `hostOffline`, `noRelays`, `versionMismatch` or `none` | The controller's connection state |
| `relays` | At most 4 of `{ host, connected, refused, dropped, held, givenUp }`; counts 0 to 9,999 | The relay health counts. `host` is a built-in relay's host from `src/config.ts`, else `other`; relay notice text is never read |
| `directPeers`, `people` | Integers, 0 to 999 | Counts only: no ids, no names. `directPeers` is the peers the page's direct (WebRTC) path reports: the facilitator's count of people on a direct link, a participant's count of its own direct peers (the host and, in a mesh, other participants) |
| `trouble` | `null`, or `{ source, forSeconds }`; source `startup`, `save`, `connection` or `error`; seconds 0 to 86,400 | The trouble state |
| `uptimeSeconds` | 0 to 604,800 | Since the page loaded |
| `errors` | At most 3, newest first, of `{ source, name, message, stack, agoSeconds }` | Error capture, below |

### Errors

Each error is `source` (`error`, `unhandledrejection`, `startup` or `save`), a `name` from a fixed list (`Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `QuotaExceededError`, `NotAllowedError`, `InvalidStateError`, `SecurityError`, `AbortError`, `NetworkError`, `DataError`, `ConstraintError`, or `other`), a `message` of at most 120 characters, a `stack` of at most six frames and `agoSeconds`.

- A frame is `file:line:column` of one of our own scripts, with no path and no hash suffix (`index-ab12cd34.js` becomes `index`); frames from any other origin are dropped, and function names are never kept.
- The message is scrubbed: every quoted run (single, double, backtick, curly or guillemet quotes) becomes `"…"` (an apostrophe inside a word is not a quote; a quote that never closes takes the rest of the message with it), email addresses become `[email]`, only the first line is kept, a message that looks like a meeting link becomes `[withheld]`, and it is cut to 120 characters.
- The app registers the strings it holds (the meeting's name, topics and names, its key, the address fragment) in a write-only list. The address fragment and its `b`, `k` and `h` values are registered as the meeting view opens, before it starts, so a start-up error that quotes them is withheld; the board's own words follow as its state arrives. A `b=`, `k=` or `h=` parameter in a message becomes `[key]` whatever the length of its value. A message or stack that contains any of them (three characters or more, case-folded) is replaced by `[withheld]`.
- Only an `Error` or a `DOMException` has its name, message and stack read. Anything else thrown becomes `other` with no message.
- Uncaught errors and rejections count only when the script is from the page's own origin; the `ResizeObserver loop` family, resource-load failures and extension scripts are ignored. The list collapses repeats and counts at most 20 events a minute.

**Residual risk, stated plainly.** The scrub removes quoted text and the list knows only what it was told. An error message can, rarely, carry a fragment of board text that was neither quoted nor registered. It is capped at 120 characters, the person reads it in the report before sending. If that is not acceptable the field can be dropped at no loss, because the error signature uses the name and the first stack frame.

### Never collected

The URL, its fragment and query, the page title, the referrer, the board id, the meeting key, topic text, comments, anyone's name (the sender's too), the meeting name, vote counts, the contents of storage, peer or device ids, the order or timing of board actions, and cookies (there are none).

How that is held: the report builder takes only typed inputs (literals, bounded integers and capped strings made by checking constructors), so a free string cannot be assigned to a field; `src/feedback/` imports nothing from the engine, sessions, store, protocol or views and reads no `location`, title, referrer or storage (except `location.origin` in error capture, to keep only our own frames); and tests plant sentinel text in every place the app holds board content and fail if any reaches a report.

## A meeting link in the message is refused

The sheet refuses to send, and the endpoint rejects, any text that looks like a share link, read raw and after one round of URL-decoding:

- a `#` followed, later, by a `b=` or `k=` parameter;
- a `b=` or `k=` parameter with a value of 16 or more URL-safe characters;
- `retrobrew.app/app` followed by a `#`.

Ordinary text that mentions `b=` or `k=` in a sum passes. The rules also run over the report's strings, so an error message cannot carry a link.

## The optional email

An optional reply address. It is a separate top-level key, never inside `report`; the owner alone sees it; it is kept 90 days at most and deleted at once on request. One rule checks it in the sheet and at the endpoint: one plain address, trimmed; at most 254 characters; no display name, list, quotes, angle brackets, whitespace or control characters; exactly one `@`; a local part of 1 to 64 characters; a dotted domain whose last label is at least two characters and has a letter. The domain is lower-cased and an international domain is sent in its punycode form, and the endpoint accepts only that canonical form. No confirmation email is sent, so an address is not verified.

## Sending

`POST /feedback` on the same origin, `content-type: application/json`, no credentials, no cache, no referrer, redirects refused; a 15 second limit. Statuses: 202 sent; 429 too many (try again in a few minutes); 400 or 413 not accepted (shorten it); anything else, a network error or a refused redirect is a failure. A body is at most 16,384 bytes; the largest report the client can make is far below that.

## The sheet

`FeedbackSheet` (`src/app/views/FeedbackSheet.tsx`) is a `Sheet` titled "Send feedback". From the top: a line saying why, only when opened in trouble ("The app noticed that a save failed."); "What is it?" (a `Segmented` of "Something broke", "An idea" and "Something else", the last by default and the first when opened in trouble); "Your message" (2,000 characters, a count from 200 left that is spoken only at 100, 50, 20 and 0 left); "The report we'll send with it" (a disclosure, open when opened in trouble, holding a `ReportList` of readable rows and, under "Show exactly what is sent", the request body with a Copy button); "Your email, only if you'd like a reply"; the consent line with its FAQ link; Send and Cancel. The rows and the JSON are made from the same parsed body, and the JSON is the very string that is sent. While nothing can be sent yet (no message, a meeting link, a bad email) the preview shows the body with the stand-in "(your message)" and no email.

- **Refused while it matches:** a message that looks like a meeting link (an alert says so and Send is off), and an email that is not one plain address (the alert shows once the person leaves the field).
- **Sending:** Send reads "Sending…" and is off; a 15 second limit ends it as a failure. **Sent:** the body is replaced by "Thanks. Your feedback is sent." and Done, and the draft is cleared (with a line about replies when an email was given). **Failed:** an alert, with Send as the retry and "Copy what you wrote"; 429 says feedback is arriving fast, 400 and 413 say to shorten it, anything else is the general line. **Offline:** an alert and Send off until the `online` event; nothing is queued.
- **Draft:** Cancel keeps what was typed in memory for the life of the page, never in storage.
- **A paste past 2,000 characters** is cut by the browser and the sheet says so.

The sheet and its gate (`feedbackEnabled()` in `src/app/feedback-gate.ts`) show nothing unless the build carries the feature (`__RB_FEEDBACK_ORIGIN__` not empty) and, for a production build, `location.origin` is that origin. The sheet opens from these places (`src/app/feedback.tsx`; each shows only where the gate allows):

- **The meeting screen:** a ghost "Send feedback" button in the top bar on wide screens; on phones, a button beside the mode switch in the People sheet and, for the facilitator, a row at the foot of the More list. Opening it replaces any other sheet (one sheet at a time) and focus returns to the button.
- **The app home, the state pages (joining, connecting, starting, a broken link) and a failed start:** a ghost button in a footer row under the page. A failed start also has "Send feedback" beside "Try again" or "Retry".
- **A banner:** "Can't reach the meeting network" (once the connection has stayed lost for 30 seconds) and "This device couldn't save the meeting" carry "Send feedback" as a second, ghost action; the error banner has it as its own action.
- **`/app/#feedback`:** the link the landing page and guide will carry (`#feedback=landing` or `#feedback=guide` names the page for the report). It opens the home page with the sheet open; closing the sheet removes the fragment, so a reload does not open it again. Any other fragment is not ours.

While the app is in trouble these buttons gain a small accent dot with the hidden description "The app noticed a problem". The dot is a mark only: the banner text and the sheet's first line say what happened.

## Trouble

The app is "in trouble" when the meeting could not start (`startup`), a save failed (`save`), the connection has stayed lost (`connection`: the relays gone for 30 seconds), or an uncaught error happened (`error`, which stays until the page reloads or the person sends feedback). The report carries the most specific one and how long it has lasted. The pages feed the state: the host view reports a failed start, a failed save and lost relays (after 30 seconds); a participant's view reports lost relays (after 30 seconds) and the connecting panel reaching its 60 second stage; a failed start on either side is `startup`. A source clears when its condition ends or the page goes. The `error` source raises the warning banner "Something went wrong on this page. If it keeps happening, tell us what you were doing." with "Send feedback"; it ranks below every more specific banner and above the storage notice, and on an ended meeting it still shows.

## Build

`__RB_REVISION__` is the first seven digits of what `/version.txt` says, both from one rule in `src/build/revision.ts`: the `REVISION` build argument if it is a commit ID, else the checkout's `HEAD`, else `unknown`. `RETROBREW_LAUNCH=1 npm run check:assets` fails a build whose `/version.txt` is not a commit ID, so a launch build fails without one. Nothing sets that variable in the production image build yet: the production image build does not do so yet, and until it does a production image could still ship as `unknown`.

`FEEDBACK_ORIGIN` decides which builds may carry the feature, through `src/build/feedback-flag.ts` into the `__RB_FEEDBACK_ORIGIN__` define. The production image build sets it to `https://retrobrew.app` (any other value stops the build); nothing sets it yet, so every build compiles the feature out. Dev and `--mode e2e` builds set the define to `self` and mount `scripts/feedback-stub.mjs`, which answers `/feedback` with the real validator (`202`, or `400`, `413` and `415` for what the endpoint will refuse). Only `src/app/feedback-gate.ts` reads the define: `FEEDBACK_BUILT` is the one compile-time constant, tested directly (`if (FEEDBACK_BUILT)`, `FEEDBACK_BUILT && …`) at every entry from always-loaded code, so the bundler drops the feature in a build without the flag; `feedbackEnabled()` adds the origin check at run time. The sheet, the buttons, the banner actions, the trouble signals and the error listener (`installFeedback()` in `src/main.tsx`) all stand behind it, so a build without the flag places nothing and carries none of their code. `npm run check:assets` fails a build made without `FEEDBACK_ORIGIN` whose scripts hold the `"/feedback"` send path or the "Send feedback" copy, and a build made with it that lacks the send path. The stub's test routes (`/__feedback`) and the e2e hook names are listed in `npm run check:assets`, which fails a build that carries them, and fails a public page that calls `fetch(` or names `/feedback`.

## The endpoint

The service in `feedback/` (Node 22, no runtime dependencies, its own `Dockerfile`, built from the repository root) answers `POST /feedback`. It runs `validateBody` from `src/feedback/schema.ts`, the very file the page uses, so the page and the service cannot disagree. Its tests run in `npm test`. It is not deployed and nothing in the app reaches it yet.

### What it checks, in order

1. The method is `POST` and the path is exactly `/feedback`, else 405 (`Allow: POST`) or 404.
2. `Content-Type: application/json` (a charset is fine), else 415.
3. `Sec-Fetch-Site`, when sent, is `same-origin` or `none`, and `Origin`, when sent, is exactly `https://retrobrew.app`, else 403. This is no security boundary (a script can forge both); it stops other sites' pages posting through visitors' browsers. No CORS header is ever sent.
4. The body is at most 16,384 bytes (a longer `Content-Length`, or a stream that passes it, gets 413), arrives within 5 seconds (else 408) and its headers within 5. At most 64 requests are in flight (and 4 per client, counted before the body is read; a client past its share gets 429), else 503.
5. The rate limits (below; they are checked before the body is read, so a body that stalls or is abandoned counts against its address), then UTF-8 and JSON parsing, then `validateBody`. Any rejection is `400 {"error":"invalid"}` with no hint of the rule. A meeting-link match is the same 400 and is logged as `link`.
6. An exact duplicate of a report seen in the last 24 hours (the kind, message and report, not the email) is answered `202` and not stored again. The key is marked before sealing and storing, so two identical requests at once store one record (the mark is removed if storing fails). Resending the same text with an email added is therefore treated as a duplicate; the first record, without the address, is the one kept.
7. The body is sealed and stored, and the answer is `202 {"ok":true}`.

Every answer carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Content-Type: application/json`. `GET /healthz` answers `ok`.

### Limits

All in memory and none persisted. The global limit is checked first: 300 requests an hour and 1,500 a day, past which the answer is 503 with `Retry-After` and the client table is not touched. Then each client: 20 an hour and 60 a day, past which it is 429 with `Retry-After`. A refused request is not counted. A client is `HMAC(address, salt)` cut to 8 bytes; an IPv4 address is used whole and an IPv6 address is cut to its /64. The salt is random, made at start, replaced every 24 hours (which also forgets every client) and never written anywhere. At most 10,000 client keys are held; at the bound the least recently seen goes. The address comes from one header (`FEEDBACK_CLIENT_IP_HEADER`, default `x-real-ip`; a list is read from its last entry) that the ingress sets and that only the ingress can reach. It is `X-Real-IP`, the address the ingress controller has checked (from Cloudflare's `CF-Connecting-IP` only when the request came through the tunnel), never the raw `CF-Connecting-IP`, which reaches the pod unchanged and which a client on the LAN could set to anything; a missing or non-address value puts the request in one shared bucket, so a bypass can only tighten the limits. Each request that falls in the shared bucket logs the code `unattributed`, so a mis-wired header shows as a count. Homelab must confirm the exact header, end to end through Cloudflare and the ingress, before launch.

### Sealing and the inbox

Each accepted body is sealed before it is written: a fresh ECDH P-256 key agrees a secret with the reader's public key, HKDF-SHA256 derives an AES-256-GCM key, and the file holds `{ v, kid, epk, iv, ct }` (JSON, base64url). The key id, the format version and `epk` are bound into the additional authenticated data, so a record cannot be re-labelled to another key. The service is configured with one current `kid` and public key and holds no private key. To rotate, give it a new `kid` and key; the reader keeps old private keys until the last record sealed to them is past 30 days.

One file per record at `inbox/<ULID>.sealed`, mode 0600, written to a temporary name in the same directory, fsynced and renamed. The inbox holds at most 3,000 records or 30 MB; at the ceiling the oldest record is deleted to make room and the new one is accepted (the service never answers with a permanent 503).

### Retention is the service's own job

A record is deleted when the reader confirms it. Independently of the reader, a sweep at start-up and then every hour deletes any record whose modification time is over 30 days old. The promise of 30 days therefore holds with no reader running. At the ceiling the oldest records go only after the new one is safely on disk, and a failed write leaves no temporary file. After start-up an unexpected error in a request is logged as the code `error` and the service keeps serving; a failure to start still stops it.

### The internal pull route

A second listener (port 8081, `FEEDBACK_INTERNAL_PORT`) that no ingress may expose; only the reader's network may reach it. Every route but `/healthz` needs `Authorization: Bearer <token>`, checked as a SHA-256 hash in constant time against `FEEDBACK_PULL_TOKEN_SHA256`; a failure is `401 {"error":"unauthorized"}` whatever the reason.

| Route | Does |
| --- | --- |
| `GET /internal/records` | `{ "records": [{ "id", "size" }] }`, oldest first |
| `GET /internal/records/<ULID>` | The sealed record, unchanged (404 if absent) |
| `DELETE /internal/records/<ULID>` | The reader's confirmation: deletes the record and answers `200 {"ok":true}`, also when it is already gone |

An id that is not a ULID is 404 before it touches the file system.

### Logging

One JSON line to stdout per request: `{"t": UTC minute, "outcome": code, "size": bucket, "latency": bucket}`, and `{"t", "outcome", "n"}` for a sweep or an eviction. Codes: `accepted`, `invalid`, `link`, `limited_client`, `limited_global`, `too_large`, `evicted`, `duplicate`, `forbidden`, `method`, `notfound`, `unsupported`, `busy`, `timeout`, `unauthorized`, `pulled`, `confirmed`, `swept`, `error`, `started`, `unattributed`. The logger accepts nothing else, so no address, body, header value or exception text can be written, and a test feeds hostile requests full of sentinels and checks every line against a pattern.

### Configuration

Environment variables, each also readable from a file by adding `_FILE` (as a mounted secret): `FEEDBACK_SEAL_KID`, `FEEDBACK_SEAL_PUBLIC_KEY` (the reader's uncompressed P-256 point, base64url), `FEEDBACK_PULL_TOKEN_SHA256` (hex). Optional: `FEEDBACK_PORT` (8080), `FEEDBACK_INTERNAL_PORT` (8081), `FEEDBACK_INBOX_DIR` (`/data/inbox`), `FEEDBACK_ALLOWED_ORIGIN` (`https://retrobrew.app`), `FEEDBACK_CLIENT_IP_HEADER`, `FEEDBACK_MAX_RECORDS`, `FEEDBACK_MAX_BYTES`. A missing or malformed required value stops the service with a code-only log line. None of these is a secret: the service holds no private key, no model key and no token, only the hash of the reader's.

### Not built here

The reader, the image job, the ingress routes and network policies, the volume and the access-log switch-off are not part of this service.
