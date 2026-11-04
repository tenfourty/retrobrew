# Landing page and guide

The public pages at `/` and `/lean-coffee/`: structure, full copy, head metadata, the old-link redirect and the phone layout. The app's own screens are in [mvp-screens.md](mvp-screens.md).

## Principles

- **Hand-written HTML** with CSS from the design-system tokens and `--rb-*` roles. No app code. Both pages work with JavaScript off.
- **Our own origin only.** Fonts, images, the favicon and the Open Graph image are all served from retrobrew.app. `npm run check:assets` enforces this.
- **Modes.** The pages default to Business and follow the device's light or dark setting. Without JavaScript, dark mode comes from the design system's `prefers-color-scheme` fallback in `tokens.css` (a design-system addition; see [mvp-screens.md](mvp-screens.md)). A viewer who has picked Party in the app sees Party here too, where JavaScript is on.
- **The mode switch** on these pages is hand-written HTML and a few lines of script from our origin, not the app's `ModeSwitch` component. It is a "Business / Party" toggle with the same look, and it carries the `hidden` attribute until the script removes it, so it never shows without JavaScript.
- **Copy** follows the app's rules: British English, sentence case, "topic" not "card", no exclamation marks, no emoji. The pages say "Retrobrew" or "you", never "we".
- **One label.** The primary button is "Start a meeting" everywhere, and always goes to `/app/#start`.
- **Accuracy.** Every privacy and reliability claim matches [sync-protocol.md](sync-protocol.md), including its accepted gaps.

## URL layout and redirects

| Path | What it is |
| --- | --- |
| `/` | The landing page |
| `/lean-coffee/` | The guide, "How to run a Lean Coffee" |
| `/app/` | The app: "Your meetings" and the create form |
| `/app/#start` | The app with the create form focused |
| `/app/#b=…&k=…&h=…` | Share links |

**Server:** nginx answers `location = /app { return 301 /app/; }` and `location = /lean-coffee { return 301 /lean-coffee/; }`. Browsers keep a URL's fragment across a 301 whose `Location` has none, so `/app#start` still works. The security headers live in one shared include used by every location.

**Old share links.** Links made before the move look like `/#b=…&k=…&h=…`. The landing page loads `/legacy-link.js` from our origin straight after `<meta charset="utf-8">` in `<head>`, as a plain blocking script (no `async` or `defer`), so it runs before the page paints:

```js
// Share links from before the app moved to /app/ put the meeting in the root URL's fragment.
if (/(^#|&)b=/.test(location.hash)) location.replace('/app/' + location.hash);
```

It only acts on a fragment that names a board (`b=`), so in-page anchors such as `/#faq` are left alone. The fragment never reaches the server. With JavaScript off, an old link shows the landing page, whose "Start a meeting" and "Your meetings" links still work.

## Landing page structure

1. Top bar
2. Hero
3. How Lean Coffee works (four steps)
4. Why Retrobrew
5. FAQ (`id="faq"`)
6. Footer

### 1. Top bar

- Left: the "Retrobrew" wordmark, set in the display face, linking to `/`.
- Right: "Your meetings" (a quiet text link to `/app/`), the primary button "Start a meeting" (to `/app/#start`) and the mode switch (hidden without JavaScript), so the switch sits at the top of every page, as it does in the app. The bar wraps rather than overflows on a narrow screen.
- At 360 px: "Your meetings" leaves the top bar and appears in the hero and the footer instead.

### 2. Hero

> **Let the room set the agenda**
>
> Retrobrew runs Lean Coffee meetings. Everyone brings topics, votes for what matters most, and talks in short timeboxes, so the conversation goes where the group wants it to.
>
> Free, private, and no sign-up.
>
> [Start a meeting]  Your meetings
>
> Runs in your browser on phones and laptops. Nothing to install.

"Your meetings" in the hero shows at every width, as a quiet link beside the button (below it at 360 px). Beside the copy on wide screens, below it on phones: a still of a board built from design-system markup (`TopicCard`s with `VoteDots`, and a `DialTimer`), marked `aria-hidden="true"`.

### 3. How Lean Coffee works

Heading: **How Lean Coffee works**

Each step has a small illustration built from design-system markup, `aria-hidden="true"`, since the text says everything.

1. **Bring topics.** Everyone adds the things they'd like to talk about, from their own phone or laptop. *(Illustration: a `TopicInput` above two `TopicCard`s.)*
2. **Vote.** Each person gets three votes to spread out or stack on one topic. The most wanted topics rise to the top. *(Illustration: `TopicCard`s with `VoteDots`.)*
3. **Talk in short timeboxes.** The facilitator picks the top topic and starts a timer, often five minutes, so no single topic takes over. *(Illustration: a `DialTimer` on a live `TopicCard`.)*
4. **Keep going or move on.** When time's up, everyone votes to keep going or move on, and the facilitator makes the call. *(Illustration: the `TimeUpVote` panel with its three choices, the totals and the turnout line.)*

Below the steps: "New to Lean Coffee? Read the short guide" (to `/lean-coffee/`).

### 4. Why Retrobrew

Heading: **Why Retrobrew**

- **Free and open source.** Retrobrew is MIT licensed. Read the code, or run your own copy, from [GitHub].
- **No accounts, no tracking.** There's nothing to sign up for, no analytics and no cookies.
- **The meeting stays with you.** The meeting lives on the facilitator's device, and attendees see a copy while they take part. Messages pass through public relays encrypted, so the relays can't read them.
- **Made for phones.** Run the meeting from your phone, or take part from one. People join by scanning a QR code.

### 5. FAQ

Heading: **Questions**. Each question is a `<details>` element with its `<summary>`, so the answers open without JavaScript.

**Where is my data?**
On the facilitator's device. The meeting is stored in the browser that started it, and there's no meeting server keeping a copy. Attendees' browsers keep the board only while they take part, plus the meetings they joined and their name in each, and a key that identifies their device. When a meeting ends, the facilitator can back it up to a file from the meeting. That matters most on Safari, which can delete a site's data after seven days without a visit.

**What do the relays see?**
Messages always pass through public Nostr relays, and also go directly between devices where a direct connection works. Everything is encrypted with a key that sits in the part of the meeting link after the `#`, which browsers never send to a server, so the relays see IP addresses, timing and message sizes, but not what anyone wrote. A direct connection shows your IP address to the facilitator's device, and to a STUN server run by Cloudflare or Google that helps set it up.

Hidden votes are hidden on screen, not cryptographically secret. The same goes for the vote on whether to keep going: Retrobrew never shows or stores who chose what, but everyone in a meeting shares its key, so an attendee who records the meeting's network traffic could work out who voted for which topic, and who chose what.

**What if the facilitator closes the tab?**
Attendees can still read the board, but nobody can change it until the facilitator opens the meeting again in the same browser, from "Your meetings". A running timer keeps going on the facilitator's clock, so if it runs out while they are away, time's up appears for everyone once they are back, and then everyone carries on. The same happens if the facilitator's phone locks, so Retrobrew asks it to stay awake while the meeting runs. A private window forgets the meeting when it closes. Browsers may clear saved meetings when space runs low, so Retrobrew reminds the facilitator to make a backup now and then. "Your meetings" also lists the meetings you joined on this device, so you can come back to one with a tap while the facilitator is running it, and each meeting has a Remove button if you want it off the list.

**Does it work on a work network or VPN?**
Usually. Retrobrew needs to reach a few public relays over secure WebSockets, the same kind of connection many chat and collaboration tools use. Some company networks and VPNs block these. If yours does, the app says it can't reach the meeting network, and switching to mobile data or a home connection is the quickest fix.

**How many people can take part?**
Up to 60 people and 60 topics in one meeting. Very long topics or names in some scripts, such as Chinese or emoji, fill a meeting sooner, and Retrobrew says so when it happens. A typical meeting of 15 people and 30 topics uses about a quarter of the room. Lean Coffee works best for groups of about 5 to 15.

**Why is it free?**
It's an open-source project with nothing to sell: no adverts, no paid plan and no data. There's no meeting server to pay for either, because each meeting runs in the facilitator's browser.

### 6. Footer

- "Retrobrew is open source under the MIT licence." with links "Source on GitHub" and "MIT licence" (the `LICENSE` file on GitHub).
- "How to run a Lean Coffee" (to `/lean-coffee/`) and "Your meetings" (to `/app/`).
- "Version {commit}", where the build writes the short commit from `REVISION`, linking to `/version.txt`.

## The guide (`/lean-coffee/`)

**Structure:** the same top bar and footer as the landing page; one article, at most 65 characters wide, with the headings below; and at the end the primary button "Start a meeting". The copy:

---

# How to run a Lean Coffee

A Lean Coffee is a meeting without a fixed agenda. The people taking part decide what to talk about, vote on it, and then work through the most wanted topics in short, timed rounds. It suits team check-ins, retrospectives, community meetups and any group that has more to talk about than time to talk in. A session usually lasts 45 to 90 minutes, for about 5 to 15 people.

## What you need

One person to facilitate, and everyone with a phone or laptop. With Retrobrew, the facilitator starts the meeting in their browser and shares a link or QR code; everyone else joins from their own device with just a name. The meeting runs on the facilitator's device, so they keep that page open until the end.

## Running it, as the facilitator

**1. Collect topics.** Start the meeting, invite people, and give everyone a few minutes to add topics. Ask for short ones: a question or a few words is enough. One idea per topic makes voting fair.

**2. Vote.** Each person has three votes. They can spread them across topics or put several on one they care about. If people want more say, allow more votes. You can turn Show votes off while people vote, so early votes don't sway later ones.

**3. Start the discussion.** When the votes are in, start the discussion. Topics line up in To discuss, most votes first. Pick the top one and choose a timebox: five minutes is a good start, shorter for a big group or a long list.

**4. Talk.** The topic's author usually opens with a sentence or two of context. Keep an eye on the clock but let the conversation run. If a topic turns out not to be ready, return it to To discuss and pick another.

**5. Time's up: keep going or move on.** When the timer runs out, everyone votes: keep going, no preference, or move on. The vote guides you, but you decide. Keep going for a few more minutes if the room is still engaged; move on if the energy has dropped or the point has been made. Repeat with the next topic.

**6. Close.** Leave a few minutes at the end. End the meeting, copy the outcome as text, and paste it wherever your group keeps notes. Back up the meeting file if you might want it later. Open the file in a second browser only to carry on there after closing the first: if the meeting is open as facilitator in two browsers at once, both show a warning, and changes made in each will not match. To clear a meeting off "Your meetings", use its Remove button; it deletes a meeting you ran from this browser, so back it up first.

## Taking part

- **Join** from the link or QR code the facilitator shares, and add your name.
- **Add topics** you'd like to talk about. Your name shows on the topics you add. You can edit or delete them while they're waiting to be discussed, but not once their discussion starts.
- **Vote** for the topics you most want to talk about. You can put more than one vote on a topic, and take votes back while it's waiting to be discussed. Once its discussion starts, those votes are spent.
- **Talk.** Listen as much as you speak, and keep to the topic on the board. New ideas can go in as new topics at any time.
- **When time's up,** vote to keep going or move on. Retrobrew never shows or stores who chose what; the totals help the facilitator decide.

## Tips

- **Keep topics short.** A topic people can read at a glance gets more votes than a paragraph.
- **Don't fear moving on.** A topic that ran out of steam has done its job. If one needs more time, add it again as a new topic, now or at your next Lean Coffee.
- **Make room for quieter voices.** A timebox makes it easier to ask someone who hasn't spoken yet.
- **Note what matters.** At the end, everyone can copy the list of what was discussed, in order.

---

That is about 600 words.

## Head metadata

Every page has `<html lang="en-GB">`, `<meta charset="utf-8">` first, `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<meta name="color-scheme" content="light dark">`, and the favicon (`/favicon.svg`, with `/favicon.png` at 32 px and `/apple-touch-icon.png` at 180 px). All URLs below are on our own origin.

### Landing page (`/`)

```html
<title>Retrobrew: free Lean Coffee meetings in your browser</title>
<meta name="description" content="Run a Lean Coffee where the people in the room set the agenda. Free, open source and private, with no sign-up. Join from any phone or laptop.">
<link rel="canonical" href="https://retrobrew.app/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Retrobrew">
<meta property="og:locale" content="en_GB">
<meta property="og:url" content="https://retrobrew.app/">
<meta property="og:title" content="Retrobrew: let the room set the agenda">
<meta property="og:description" content="Free, private Lean Coffee meetings in your browser. Everyone brings topics, votes, and talks in short timeboxes.">
<meta property="og:image" content="https://retrobrew.app/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Retrobrew wordmark beside index cards and coloured vote dots">
<meta name="twitter:card" content="summary_large_image">
```

`og.png` is a static 1200 × 630 image made from the design system's cover (`design/system/components/Cover/`), in Business light.

### Guide (`/lean-coffee/`)

```html
<title>How to run a Lean Coffee · Retrobrew</title>
<meta name="description" content="A short guide to Lean Coffee meetings: collecting topics, voting, timeboxes and deciding when to move on, for facilitators and participants.">
<link rel="canonical" href="https://retrobrew.app/lean-coffee/">
```

It carries the same Open Graph and `twitter:card` tags as the landing page, with `og:url`, `og:title` ("How to run a Lean Coffee") and `og:description` (the meta description) changed to match.

### App (`/app/`)

- `<title>Retrobrew</title>` on every app page, meetings included, so meeting names never land in browser history or tab lists.
- `<meta name="robots" content="noindex">`, since the app pages have nothing to index.
- The same favicon.

### Crawlers

- **`/robots.txt`:**

  ```
  User-agent: *
  Allow: /
  Disallow: /app/
  Sitemap: https://retrobrew.app/sitemap.xml
  ```

- **`/sitemap.xml`** lists `https://retrobrew.app/` and `https://retrobrew.app/lean-coffee/`.

## Layout at 360 px

- One column throughout, with the `space-4` (16 px) gutter and no horizontal scroll. Sections are separated by `space-8`.
- **Top bar:** the wordmark on the left, "Start a meeting" (the `sm` button size, still at least 44 px tall) and the mode switch on the right. "Your meetings" moves to the hero and footer.
- **Hero:** heading at the `title` size, then the text, then "Start a meeting" at full width with "Your meetings" below it as a text link. The board still sits below, scaled to the column width.
- **Steps:** stacked, each with its illustration above its text, illustrations at most 280 px wide.
- **Why Retrobrew:** a single list.
- **FAQ:** full-width `<details>` rows, each summary a tap target of at least 44 px.
- **Footer:** links stacked one per line, then the version.
- From 768 px the hero puts the board beside the text, the steps sit in a row of four (two by two between 768 and 1024 px), and "Why Retrobrew" uses two columns.

## Open choices made

1. **The hero headline is "Let the room set the agenda",** and the page says "Retrobrew" or "you", never "we".
2. **An extra FAQ, "How many people can take part?",** states the 60-person and 60-topic limits and the size cap.
3. **The relays answer names the STUN servers** and message sizes as well as IP addresses and timing, so it is complete.
4. **The redirect script is `/legacy-link.js`,** blocking, first in `<head>`, and acts only on a fragment containing `b=`.
5. **The version** is written into the footer at build time and links to `/version.txt`, so it shows with JavaScript off.
6. **App pages are `noindex`,** disallowed in `robots.txt`, and always titled "Retrobrew".
7. **The source and licence links point at the public GitHub repository,** set as `SOURCE_URL` and `LICENCE_URL` in `vite.config.ts`. `RETROBREW_LAUNCH=1 npm run check:assets` fails a build that still links the bare `https://github.com/`.
8. **The Open Graph image is made from the design system's cover.**
