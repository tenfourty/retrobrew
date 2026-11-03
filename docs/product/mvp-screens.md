# MVP screens

Every screen and state of the MVP app, for the facilitator and for participants, at phone and wide widths, with the exact copy. The rules behind them are in [lean-coffee-rules.md](lean-coffee-rules.md) and the connection behaviour in [sync-protocol.md](sync-protocol.md). The landing page and the guide are in [landing.md](landing.md).

## Conventions

- **Widths.** "Phone" means below 768 px; "wide" means 768 px and up. Every screen works from 320 px, with the `space-4` (16 px) gutter and no horizontal scroll.
- **Design system.** Screens use only `design/system/` tokens, `--rb-*` roles and components, in Business and Party modes, light and dark. Component names below are from `design/system/components/index.d.ts`. Anything the system lacks is listed under [Design-system additions needed](#design-system-additions-needed) and is added to the system before the screen that needs it.
- **Copy.** British English, sentence case, "topic" never "card", no exclamation marks, no emoji. The app speaks to the viewer as "you" and never says "I" or "we". Buttons are verbs. Single-sentence guidance lines and labels have no full stop; banners and dialog bodies are full sentences with full stops.
- **Placeholders.** `{name}` is filled in at run time. `#{n}` is a topic number, such as "#4". `{topic}` is a topic's text. `{len}` is a length written out by the rules in [Lengths](#lengths).
- **"Facilitator"** means the meeting's owner. In the MVP the owner is the only facilitator and always runs the host.

### Lengths

Times and timeboxes are written the same way everywhere:
- in labels: "1 min", "5 min", "30 min"; on rehearsal boards by their real length: "10 s", "50 s", "1 min 40 s", "5 min";
- in sentences: "1 minute", "3 minutes"; on rehearsal boards "10 seconds", "30 seconds";
- added time, in sentences: `{more}` reads "1 more minute", "3 more minutes", or on rehearsal boards "10 more seconds", "30 more seconds";
- countdowns: `m:ss`, in tabular numerals (`DialTimer`).

## The app home (`/app/`)

**Who:** anyone. It lists meetings started in this browser and starts new ones.

**Top bar** (`.rb-topbar`): the "Retrobrew" wordmark (`.rb-title`, links to `/`), a "How Lean Coffee works" link (to `/lean-coffee/`) and the `ModeSwitch`. At phone width the link moves under the form.

**Start a meeting** (a `card` panel):
- Heading: "Start a meeting".
- Field "Meeting name" (`.rb-input`, up to 80 characters), placeholder "Team Lean Coffee".
- Field "Your name" (`.rb-input`, up to 60 characters), filled in from the device if known and the field is still empty when the device's name loads (in a fresh browser that can be a moment after the form appears, so a name already typed is kept). Hint: "Everyone in the meeting sees this name next to the topics you add".
- `Button` primary: "Create meeting".
- Errors (inline alert under the field): "Enter a meeting name", "Enter your name".
- **`/app/#start`** opens this page with focus in "Meeting name".
- **Creating** saves the meeting, asks the browser to keep it (banner 6 below) and leaves one note in this tab's `sessionStorage`, so the host view opens the share step once. The wordmark and the guide link are `.rb-link`s, 44 px tall.
- **`/app/#start&rehearsal`** shows the same form headed "Start a rehearsal meeting", with the line "Timeboxes are shortened, for trying things out" under the heading, and creates a rehearsal board.

**Your meetings** (a `card` panel):
- Heading: "Your meetings".
- One row per meeting in this browser, most recently opened first: the meeting name (a link that opens it), the "Rehearsal" badge where it applies, and a status line: "Collecting topics", "In discussion" or "Ended {date}", with dates as "6 Oct 2026".
- Empty: "Meetings you start in this browser are listed here".
- "Open a meeting file" (a file input styled as a `Button` secondary). Errors: "That file isn't a Retrobrew meeting file", "That meeting file is damaged or incomplete", and, for a file made before sync protocol 3 (backup file version 1), "That meeting file was made by an older version of Retrobrew and can't be opened. Please start a new meeting". A file too big to read counts as the first; a meeting open in another tab is refused with its own line.
- Footnote: "This browser can delete meetings you haven't opened for a while. Back up each meeting when it ends."

**Phone:** the two panels stack, form first. **Wide:** the two panels sit side by side, form on the left.

## The share step

**Who:** the facilitator, straight after creating a meeting, and whenever they choose "Invite people".

A **Sheet** (phone: from the bottom; wide: a centred dialog) titled "Invite people":
- **QR code** of the share link, drawn in the browser by a small bundled library, at least 240 px square, on the **QR panel** (dark modules on a light ground in every theme, with a 4-module quiet zone). Accessible name: "QR code for the meeting link".
- Line under it: "Scan to join, or share the link".
- `Button` primary "Share link", only where `navigator.share` exists. It opens the native share sheet with the title "{meeting name}" and the text "Join my Lean Coffee on Retrobrew".
- `Button` secondary "Copy link". After a successful copy its label is "Link copied" for 2 s, announced politely. If the clipboard is refused, the link is shown in a read-only field, selected, with "Copy the link from here".
- Note: "Anyone with this link can join and read the meeting. Share it only with the people taking part."
- `Button` ghost "Done", which closes the sheet.

On wide screens, "Share link" shows only if `navigator.share` exists, which on most desktops it doesn't; "Copy link" is then the primary button.

## The join screen

**Who:** a participant opening a share link for a meeting they don't host.

- Top bar: the "Retrobrew" wordmark and the `ModeSwitch`.
- Heading: "You're invited to a Lean Coffee".
- Line: "Choose the name the group will see. The board opens as soon as the facilitator's device answers."
- Field "Your name" (`.rb-input`, up to 60 characters), filled in from the device if known and the field is still empty when the device's name loads (in a fresh browser that can be a moment after the form appears, so a name already typed is kept). Hint: "Everyone in the meeting sees this name next to the topics you add".
- `Button` primary "Take part". This tap also unlocks audio on iOS.
- Link: "How Lean Coffee works" (opens `/lean-coffee/` in a new tab, so the meeting stays open).

**Join states:**
- **Empty name.** The form checks before sending: an inline alert under the field, "Add your name first" (the engine's `emptyName`), and focus stays in the field.
- **After a refusal** the form comes back with focus in "Your name", its text selected, so typing another name replaces it.
- **After "Take part"** the participant sees the connecting states (see [Connecting](#connecting)) until the first view arrives that lists them as an attendee, including after a refused join is retried.
- **Meeting full.** If the host refuses the join with `meetingFull` or `meetingFullSize`, the connecting panel is replaced by the join form again, with that message ("This meeting is full. It can have up to 60 people" or "This meeting is full") as an alert above the button. "Take part" tries again; the host remembers a refusal for 30 s and, for the same name, repeats it without running the join again (for `meetingFullSize`, a smaller board can clear the refusal, so the join runs again after 5 s).
- **Coming back.** The device remembers, per meeting, that it has joined and under which name. Opening the same meeting again (a reload, or the link once more) skips this screen and rejoins silently with the stored name, going straight to the connecting states. Changing the name stored on the device is post-MVP. The device records the join once the host has listed the person as an attendee, so a join that was refused, or never answered, shows the form again. If the host refuses a silent rejoin, the device forgets the stored name and the form shows with that refusal. A meeting is its board ID and its facilitator's key: the name is stored with the key from the link it was given under, and a link with the same board ID but another facilitator's key shows the form rather than rejoining. The device keeps the 20 most recent meetings and drops the oldest.
- **An ended meeting.** Joining works as usual, and the first view shows the ended view directly, read-only, with Copy as text. When the person has just used Take part or Retry, focus lands on Copy as text (their button has gone); a silent rejoin of an ended meeting moves no focus.

**A broken link** (a fragment that looks like a meeting link but doesn't parse) shows the heading "This link isn't complete" and "Ask the facilitator to share the meeting link again." No join form.

## The board: shared layout

Every phase uses the same frame.

**Top bar** (`.rb-topbar`):
- The meeting name (`.rb-title`, an `h1`), and the "Rehearsal" **Badge** beside it on rehearsal boards.
- The **attendee count**, a `Button` ghost sm: "{n} here", where n is the number online. It opens the People sheet.
- `VoteBudget` in the topics and discussion phases: "{n} votes left", "1 vote left" or "No votes left".
- `ModeSwitch` (wide only; on phones it lives in the People sheet).

**Guide line** (`.rb-sub`, under the title), phrased for the viewer's role, followed by the link "How Lean Coffee works" (new tab):

| Phase | Participants | Facilitator |
| --- | --- | --- |
| Topics | "Add topics you'd like to talk about, then spend your {n} votes" | "Invite people, add topics and vote. Start the discussion when the votes are in" |
| Discussion | "The facilitator picks the next topic. You can still add topics and vote" | "Pick the next topic from To discuss. Everyone can still add topics and vote" |
| Ended | "This meeting has ended" | "This meeting has ended. Copy the outcome or reopen it" |

`{n}` is the current allowance.

**Facilitator line**, under the guide on the facilitator's screen only: "This meeting runs on this device. Keep this page open."

**People sheet** (Sheet titled "People"):
- One `AttendeeChip` per attendee, online first, then alphabetical, with `online` set from the view and `role` "Facilitator" for the owner. The viewer's own row adds "(you)" to the name.
- Offline people are marked by the avatar's colour and, for screen readers and so colour is not the only signal, by a visually hidden "(offline)" after the name; the facilitator's rows say "Offline" in words.
- For the facilitator only, each row also says how that person is connected: "Direct", "Through relays" or "Offline".
- Section "This device": the switch "Play the timer sound on this device" and, on phones, the `ModeSwitch`.
- For the facilitator only, a disclosure "Connection details": each relay (updated whenever a relay's state changes) with "Connected" or "Not connected", "Refused by relays: {n}" (`OK false` replies), "Relay notices: {n}" (`NOTICE` replies) and, once there has been one, "Oversize events: {n}" (bundles still over the relays' size limit after trimming, see [sync-protocol.md](sync-protocol.md), Size). Both sessions report each relay's state as it changes (`RelayHealth`); the sheet shows the state and the counts above. The transport's held and dropped event counts are not shown: browser-battery builds expose them to the tests only (`window.__rbRelayHealth`), which print them when the ten-person burst test fails.

**Facilitator controls:** the action bar and the Facilitator sheet (below). On phones the action bar sticks to the bottom of the screen; on wide screens it sits at the top of a side panel to the right of the board.

## The topics phase

**Everyone:**
- **Add box** (`TopicInput`): placeholder "Add a topic", button "Add topic", hint "Everyone in the meeting sees this name next to the topics you add". Enter submits and keeps focus in the box; line breaks can't be typed. From 240 characters a counter shows "{n} characters left"; the box stops at 280.
  - Phone: the add box pins to the bottom of the screen, above the facilitator's action bar. While it has focus, the action bar hides so the keyboard has room.
  - Wide: the add box sits above the Ideas column.
- **Ideas** (`Column` state `ideas`, heading "Ideas" with the count): a pinboard of `TopicCard`s, newest first. On wide screens the cards wrap in a grid; on phones they stack.
  - Empty: "No topics yet. Add the first one."
- **Each topic** (`TopicCard`): its number, text and author, `VoteDots` with the count and the viewer's own dots, and these actions (`Button` sm):
  - "Vote" (secondary), disabled when the viewer has no votes left, with the description "You have no votes left";
  - "Remove vote" (ghost), when the viewer has a dot on it;
  - "Edit" (ghost), for the author;
  - "Delete" (`Button` variant `danger`, size `sm`), for the author and the facilitator.
- **Editing** turns the card's text into a field holding the text, with `Button` sm "Save" (primary) and "Cancel" (ghost). Enter saves; Escape cancels. Saving empty text asks the delete confirmation; cancelling that leaves the topic as it was, out of editing. The field limits its text to 280 characters as the add box does: only what a paste or keystroke added is cut, never the text already there, the caret stays where the insertion ended, and an input method's composition is cut when it ends. Focus returns to "Edit" after Save, Cancel, Enter or Escape, and after cancelling the delete confirmation.
- Tapping "Add topic" keeps focus in the add box, as Enter does, so a phone keeps its keyboard open.
- **Focus after other actions.** When the last "Remove vote" goes, focus moves to that card's "Vote". After "Delete topic", focus goes to the neighbouring card's first button, or to the Ideas region when no card is left. If someone else deletes the topic while its delete confirmation is open, the confirmation closes.
- **Authors.** Attendees are never removed from a board, so every topic's author is listed and the card always shows a name.
- **A refusal** shows beside the control the refused command came from (the add box, or the card), even when a later action was made before it arrived. A refusal for a topic that is no longer on the board shows at the top.
- **Show votes off:** everyone, the facilitator included, sees only their own dots on Ideas topics, and in place of the count the card says "Votes hidden". Under the Ideas heading: "Votes are hidden until the discussion starts".
- **Discussed** (`Column` state `discussed`), only when the meeting has come back from a discussion: the topics already discussed, in `discussedOrder`, read-only with their votes, below Ideas (phone) or beside it (wide).

## The discussion phase

**Wide:** three columns side by side (`Column`), each at least 260 px wide. When the main area is narrower than three of them need (a facilitator's tablet at 768 px, with the 280 px side panel beside it), the columns wrap and stack, in the same order, so no column is squeezed:
- **To discuss** (state `todiscuss`, with the count). Topics in vote order. Topics with no votes sit at the end under the group heading "No votes yet", shown only when some topic has votes (with none voted, every topic is unvoted and the heading is left out). The heading is an `h2`. Empty: "Every topic has been discussed. Add another, or go back to topics to collect more."
- **Discussing** (state `discussing`, no count). The topic as a `TopicCard` with `live`, and in it the `DialTimer` (or "No timer" when untimed). The dial reads `0:00` when the timer runs out, and says "Time's up" only once the vote is open, as the status strip does. Empty, for guests: "Nothing is being discussed yet. The facilitator picks the next topic." For the facilitator: "Pick a topic from To discuss."
- **Discussed** (state `discussed`, with the count), in `discussedOrder`. Empty: "Finished topics appear here".

The add box stays above the columns, with the button label "Add another topic". New topics land at the end of To discuss.

**Phone:** a **Tabs** row under the top bar: "To discuss {n}", "Discussing" and "Discussed {n}", one column per tab. The **Status strip** sits between the top bar and the tabs on every tab:

| State | Status strip |
| --- | --- |
| Nothing in Discussing | "Discussion · Next topic coming up" |
| Timer running | "#{n} {start of topic}" and the countdown, such as "3:12" |
| Untimed | "#{n} {start of topic}" and "No timer" |
| Time-up vote open | "#{n} {start of topic}", "Time's up" and the "Vote" chip |

- The start of the topic is its first 24 characters followed by "…" if longer. The strip's accessible name uses the full text.
- Tapping the strip opens the Discussing tab. Tapping the "Vote" chip reopens the time-up sheet.
- The strip's accessible name has the full text and "Time's up" or "No timer", but not the running countdown. Each tab panel is in the Tab order, as its content can be text only.
- **Focus.** When the time-up sheet closes and the control that opened it has gone (the vote ended), focus goes to the facilitator's primary action; for a guest, to the strip (phone) or the Discussing column (wide). "Start again" from the time-up sheet lands on the facilitator's primary action too. After "Delete topic" focus goes to the next topic card in the column, else the previous, else the column itself.
- **Edit drafts** survive the layout changing between columns and tabs. A draft is kept while its topic can be edited; a topic in Discussing or Discussed has no "Edit".
- **Switching tabs.** When a topic starts, the app switches to the Discussing tab, but not while the add box has focus or holds a draft.

**To discuss topics** show "Vote" and "Remove vote" as in the topics phase, "Edit" and "Delete" for the author, and "Delete" for the facilitator. The facilitator also sees `Button` sm primary "Discuss" on each one, which opens the timebox picker for that topic.

**Discussing and Discussed topics** show no actions; their dots are spent.

## The timebox picker

**Who:** the facilitator, from "Discuss #{n}" in the action bar, a topic's "Discuss" button, or "Start timer" for an untimed topic.

A Sheet:
- Title: "Discuss #{n}" (or "Start a timer for #{n}" when the topic is already in Discussing), with the topic's text below.
- **Timebox choice** (a **Segmented choice** of nine options): "1 min", "2 min", "3 min", "4 min", "5 min", "10 min", "15 min", "20 min", "30 min". On rehearsal boards they read "10 s", "20 s", "30 s", "40 s", "50 s", "1 min 40 s", "2 min 30 s", "3 min 20 s", "5 min".
- The last timebox this device used is preselected, starting at 5 minutes, so starting is one tap.
- **Rehearsal boards only:** a **Switch** "Use real minutes", off each time the picker opens, with the hint "For this topic only. Otherwise a minute here lasts 10 seconds." When it is on, the options read in real minutes.
- `Button` primary "Start" (labelled with the choice, such as "Start 5 min"), and `Button` ghost "Cancel".

## The time-up sheet

**Who:** everyone, when the host opens the time-up vote. It opens by itself, on every tab, for people who join late too.

A Sheet built on **`TimeUpVote`** (extended to three choices; see the additions):
- Title: "Time's up. Keep going?"
- The topic: "#{n} {topic}".
- Three choice buttons: "Keep going", "No preference", "Move on".
- Before voting, hint: "Retrobrew never shows or stores who chose what. The facilitator decides."
- After voting: the viewer's choice shows pressed, the buttons are disabled, and the live totals show: "Keep going {a} · No preference {b} · Move on {c}", then "{n} of {m} present have voted".
- **Your own choice** is held in the page's memory only, to press the right button. It is never saved, not even on the facilitator's device: it stays out of the board record and every backup. After a reload the view still says you have voted, so the sheet shows "You've voted" with no button pressed, and the totals.
- `Button` ghost "Close". Escape also closes it. The sheet traps focus while open.
- **Stacking.** The time-up sheet opens above anything else. If the timebox picker, the Facilitator or People sheet or a confirmation is open when time runs out, that sheet closes first (keeping nothing half-done), and focus moves into the time-up sheet.
- While the vote is open, the "Vote" chip in the status strip (phone) or on the Discussing card (wide) reopens it.
- When the vote closes, the sheet closes by itself.

### The facilitator's decision

The facilitator's sheet has the same ballot, and they vote too. Below the ballot it always shows:
- the totals, as above, whether or not they have voted;
- the turnout, "{n} voted · {m} here";
- the **decision**:
  - "More time" with a Segmented choice of "1 min" to "5 min" ("10 s" to "50 s" on rehearsal boards, unless the timer uses real minutes). The last extension this device used is preselected, starting at 3.
  - Two buttons, ordered by **this rule**: if Keep going has more votes than Move on, the primary `Button` is "Keep going for {more}" and the secondary ghost `Button` below it is "Or move on". Otherwise (a tie, no votes, or Move on ahead), the primary is "Move on" and the secondary is "Or keep going for {more}". No preference votes don't count either way.
  - A note under them: "Move on finishes #{n} and moves it to Discussed."
  - A third, quieter `Button` ghost sm: "Start again", which opens the timebox picker to give the topic a fresh timebox (`restartTimer`).

So the label reads "Keep going for 3 more minutes", or "Keep going for 30 more seconds" on a rehearsal board.

"Keep going…" sends `extendTopic`; "Move on" sends `finishTopic`. Closing the sheet leaves the vote open; the action bar's "Decide" brings it back.

## Outcome lines

When a time-up vote closes, everyone sees one line for 5 seconds, just under the status strip (phone) or at the top of the Discussing column (wide), and hears it through the live region:

| What happened | Line |
| --- | --- |
| The same topic got a new timer ("Keep going…" or "Start again") | "Keeping going for {more}" |
| The topic moved to Discussed | "Moved on to the next topic" |

`{more}` is the new timer's length, so the line reads "Keeping going for 3 more minutes". Any other way the vote closes (stopped, returned, meeting ended) shows no outcome line; the board itself shows what happened. On a rehearsal timebox of 10 minutes or more the line gives minutes and seconds, for example "Keeping going for 1 minute and 40 more seconds".

## The ended view

**Everyone:**
- A **Banner** at the top: "Meeting ended" with the date, as "Meeting ended · 6 Oct 2026".
- The guide line: "This meeting has ended".
- The board, read-only, as one list in two parts: "Discussed", the discussed topics in `discussedOrder`, numbered 1, 2, 3 in that order; then "Not discussed", the other topics in vote order. Each `TopicCard` shows its votes and no actions. "Not discussed" is left out if it would be empty.
- **Copy as text** (`Button` secondary for participants, on the banner; primary for the facilitator, in the action bar).
- Participants keep this view after the host goes away and never see a connection error for it.
- The facilitator still sees a banner about saving or the network instead of the ended banner when one applies, because it may need acting on.

**Facilitator only:** "Reopen meeting" and "Back up meeting file" in the action bar. Backing up downloads `{meeting name}.retrobrew.json`, which includes the host key, after this note in a confirmation: title "Back up meeting file", body "This file holds the meeting's keys. Anyone who has it can open and run this meeting, so keep it somewhere private.", buttons "Download file" (primary) and "Cancel" (ghost).

### Copy as text

Copy as text puts this plain text on the clipboard, with `\n` line endings and a final newline:

```
{meeting name}
{date}[ · Rehearsal]

Discussed
1. {topic} ({votes})
2. {topic} ({votes})

Not discussed
- {topic} ({votes})
```

- `{date}` is `endedAt` as "6 October 2026" (`en-GB`, day month year, local time). Before the meeting has ended (from the End meeting confirmation) it is today's date.
- " · Rehearsal" is added only on rehearsal boards.
- `{votes}` is "1 vote" or "{n} votes", including "0 votes".
- "Discussed" lists topics in `discussedOrder`. Before the meeting has ended, a topic in Discussing is listed last, as ending would put it there. If nothing was discussed, the section has the single line "None".
- "Not discussed" lists every other topic in vote order (most votes first, then `position`). The heading and its blank line are left out if there are none.
- Topic text is copied exactly; it is always one line.
- **Counts and Show votes.** The facilitator's Copy as text carries the real count of every topic, even while Show votes hides counts on screen (in the topics phase, from the End meeting confirmation). The screen, and everyone else's copy, never show a hidden count; a participant's copy is made once the meeting has ended, when counts are public.
- **Known limit.** If the clipboard is refused, the read-only field shows the text, real counts included, on the facilitator's own screen, so a hidden count can appear on a shared screen at that moment.
- **Dates.** The date shows in each viewer's local time, so a viewer in another time zone can see a different day near midnight.

After copying, the button reads "Copied" for 2 s and the live region says "Outcome copied". If the clipboard is refused, the text appears in a read-only field, selected, with "Copy the text from here".

## The facilitator action bar

**ActionBar**: one primary `Button` for the next step, then secondary `Button`s (secondary or ghost). Phones: sticky at the bottom, full width, primary on the right. Wide: at the top of the side panel, stacked, every button shown.

**On phones** the bar holds the primary and at most one other button, so it fits at 320 px. A row with a single secondary shows it. A row with more shows "More" instead, which opens the **More sheet**: that row's secondaries, in order, then the Facilitator controls below them. "Facilitator" itself never appears in the phone bar when "More" does.

The first row that matches applies:

| State | Primary | Secondary |
| --- | --- | --- |
| Ended | "Copy as text" | "Reopen meeting", "Back up meeting file" |
| Time-up vote open | "Decide" (opens the time-up sheet at the decision) | "Stop timer", "Facilitator" |
| Discussing, timer running (including 0:00 before the vote opens) | "Finish topic" | "Stop timer", "Return topic", "Facilitator" |
| Discussing, untimed | "Finish topic" | "Start timer", "Return topic", "Facilitator" |
| Discussion, nothing in Discussing, To discuss not empty | "Discuss #{n}", the top topic in To discuss, opening the timebox picker | "Facilitator" |
| Discussion, To discuss empty | "Back to topics" | "End meeting", "Facilitator" |
| Topics phase, with at least one Ideas topic | "Start discussion" | "Invite people", "Facilitator" |
| Topics phase, no Ideas topics | "Invite people" | "Facilitator" |

- "Stop timer" while the vote is open keeps the topic going untimed.
- "Start timer" opens the timebox picker.
- "End meeting" opens its confirmation.
- The Ended row keeps the Facilitator controls, without "End meeting": on wide screens below the buttons, on phones in "More" below "Reopen meeting" and "Back up meeting file".
- On wide screens the side panel shows the Facilitator controls in place below the action bar, so the "Facilitator" button is left out there.

## The Facilitator sheet

**Who:** the facilitator. A Sheet titled "Facilitator" on phones; a section of the side panel on wide screens. In this order:

1. **"Invite people"** (`Button` secondary), opening the share step. Shown in every phase but Ended.
2. **"Votes each"**, a Segmented choice of "3", "5", "8" and "10". Lower values than the current allowance are disabled. Hint: "The allowance can go up but not down". Choosing one sends `raiseAllowance` at once.
3. **"Reset all votes"** (`Button` secondary), with a confirmation.
4. **"Show votes"**, a Switch. Caveat under it: "Hidden on screen. It doesn't make votes secret from other attendees." Outside the topics phase the switch is disabled, with the hint "Votes always show once the discussion starts".
5. **"Back to topics"** (`Button` secondary), in the discussion phase. While a topic is in Discussing it is disabled, with "Finish or return the topic being discussed first".
6. **"Timer sound"**, a select of "Chime", "Bell", "Wood block" and "Pips", with a `Button` ghost sm "Play" that previews the chosen sound on this device. Below it, the Switch "Play the timer sound on this device".
7. **"Return topic"** (`Button` secondary), only while a topic is in Discussing.
8. **"End meeting"** (`Button` danger), at the bottom, with a confirmation.

## Confirmations

Each is a **Confirm dialog**: a Sheet with a title, a body, and buttons. It traps focus; Escape and "Cancel" close it without acting.

| Action | Title | Body | Buttons |
| --- | --- | --- | --- |
| Reset all votes | "Reset all votes?" | "This removes every vote on topics that haven't been discussed, and gives them back. Votes on discussed topics stay spent." | "Reset votes" (danger), "Cancel" (ghost) |
| End meeting | "End the meeting?" | "Everyone sees the final board, and nobody can add or vote. You can reopen it later." When a topic is in Discussing, add: "#{n} moves to Discussed." | "Copy as text" (secondary, first), "End meeting" (danger), "Cancel" (ghost) |
| Delete topic | "Delete #{n}?" | "The topic and its votes are removed, and everyone gets those votes back." | "Delete topic" (danger), "Cancel" (ghost) |
| Back up meeting file | See the ended view | | |

"Copy as text" in the End meeting dialog copies the outcome without closing the dialog.

"Back up" on the failed-save banner opens the same confirmation as "Back up meeting file".

## Connection states and banners

**Banner** shows one message at a time across the top of the board, below the top bar. When several apply, the highest in this table wins. Banners with an action carry a `Button` sm secondary.

| Priority | Who | When | Copy | Action |
| --- | --- | --- | --- | --- |
| 0 | Participant | The meeting has ended | The ended banner, "Meeting ended · {date}", with Copy as text. It always wins for participants: no connection banner shows on an ended meeting | "Copy as text" |
| 1 | Participant | A protocol 1 view arrives naming the version message (host newer) | "This meeting was started with a different version of Retrobrew. Reload this page." | "Reload" |
| 1 | Participant | A version reply arrives from an older host | "This meeting is running on an older version of Retrobrew. Ask the facilitator to reload their page." | None |
| 2 | Everyone | No relay socket open for 10 s | "Can't reach the meeting network. Check your connection." | None |
| 3 | Participant, not ended | Host offline (20 s without a host message) | "The facilitator's device is offline. You can still read the board, and it updates when they're back." | None |
| 4 | Participant | Three resends unacknowledged | "Your last change didn't reach the facilitator." | "Retry" |
| 5 | Facilitator | A save failed | "This device couldn't save the meeting. Keep this page open and back up the meeting file." | "Back up" |
| 6 | Facilitator | `navigator.storage.persist()` didn't grant persistence when the meeting was created | "This browser hasn't promised to keep this meeting. Back up the meeting file when you finish, and don't use a private window." | "Dismiss" |
| 7 | Facilitator | The board is over a limit after loading or importing (see the rules' Boards over the limits) | "This meeting is bigger than Retrobrew's limits. It runs as normal, but new topics and people can't be added until some topics are deleted." | None |
| 8 | Facilitator | A relay bundle was still over the relays' size limit after trimming, and no full refresh has fitted since (see the sync protocol's Size section) | "This meeting is too big to send to everyone in one go. It runs as normal, but new topics and people can't be added until some topics are deleted." | None |

A participant whose tab was pruned sees the engine's `staleTab` refusal, "This page has been away too long. Reload it to carry on", as a banner at priority 4 with "Reload". A participant dropped for a newer tab of the same person sees that refusal's own message (`tooManyTabs`) in the same banner instead.

Banner 6 is driven by a note on the meeting record, `persistence`, set to `granted` or `refused` from the answer of `navigator.storage.persist()` (a rejected or missing call counts as refused). The meeting is saved first and the browser is asked after, so a permission prompt never delays the save; the meeting opens once the browser has answered. The answer is written alone, on the record as stored by then (one transaction), so it can never overwrite a state another tab has saved. While the prompt is open the Start and Import controls are off and "Saving the meeting…" shows, so a second tap can't make a second meeting. Importing a meeting file asks again in the same way and records the answer for this browser, because the note describes the browser that made the file and is never exported or imported. Meetings made before the note existed show no banner. "Dismiss" hides it for as long as the host view stays open; it shows again when the meeting is opened again.

On a version mismatch the board is read-only. While the host is offline the board stays visible and read-only: every action button is disabled.

**Refusals** (the engine's messages) appear as an inline alert next to the control that was used, or above the add box for topic commands, and are announced. They clear on the next action.

### Connecting

After "Take part" (or a silent rejoin), until the first view arrives, the participant sees a centred panel:

| Time since joining | Copy | Action |
| --- | --- | --- |
| 0–15 s | "Connecting to the facilitator…" | None |
| 15–60 s | "Still trying to reach the facilitator. They need to have the meeting open." | "Retry" |
| After 60 s | The 15 s text, then "If it still doesn't connect, check that you opened the whole link, or ask the facilitator to send it again." | "Retry" |

Retry sends a fresh hello and resets the back-off. The app keeps trying in the background throughout. A connection banner that applies before any board (for example "Can't reach the meeting network", or the version messages with "Reload") shows above this panel with the same action; the "facilitator's device is offline" banner doesn't, because the panel already says so. A participant whose first view is the ended view lands on Copy as text only when the person had just used Take part or Retry (that control has gone) and has not moved focus elsewhere; a silent rejoin moves no focus.

### Hosting states

The copy in the first column is each page's `h1`; the error under "Start-up failed" is a hint line.

| State | Copy | Action |
| --- | --- | --- |
| Starting | "Starting the meeting…" | None |
| Start-up failed | "The meeting couldn't start on this device." with the error underneath | "Try again" |
| Open in another tab | "This meeting is open in another tab." | "Take over here" |
| Taken over by another tab | "This meeting is now open in another tab." | None |

## Timer sound

- **Sounds.** Four short sounds made in the browser with Web Audio, so there are no files and no requests: Chime (`chime`, the default), Bell (`bell`), Wood block (`woodblock`) and Pips (`pips`). The facilitator picks the board's sound in the Facilitator sheet.
- **Where it plays.** At time up, on devices where "Play the timer sound on this device" is on. It plays once for each vote, only for a vote the page saw open: a page that arrives, or rejoins, after time up hears nothing, and a reconnect, a tab switch or a layout change never plays it again. It is on by default for the facilitator and off by default for participants. Each device stores its own setting, in its own browser, for every meeting.
- **iOS.** The first tap on "Take part", "Vote", "Add topic" or "Play" unlocks audio for the page. After a silent rejoin, the first tap of any kind does.
- The time-up sheet is always the main signal; the sound is extra.

## Keeping the facilitator's phone awake

While hosting, the app requests a screen wake lock (`navigator.wakeLock.request('screen')`) where it exists, and requests it again whenever the page becomes visible; a lock that replaces an older one releases the older one. It releases it when the host view closes. Where wake locks don't exist, the "Keep this page open" line is the only guard.

## Accessibility

- Every control has an accessible name. There are no icon-only controls in the MVP.
- Sheets and confirmations trap focus, return focus to the control that opened them, and close with Escape.
- One polite live region announces:
  - phase changes: "Discussion started", "Back to collecting topics", "Meeting ended", "Meeting reopened";
  - a topic starting: "Now discussing #{n}: {topic}";
  - the countdown, only at "1 minute left" (or "10 seconds left" on a rehearsal timer), once for each timer: a page that joins or wakes more than 5 seconds into that last minute does not say it (5 seconds for a real timer and a rehearsal one alike), a timer of one minute or less, such as a 1-minute timebox or a 1-minute extension, never says it, and a timer started by "keep going" says it again at its own mark. Time up is announced as "Time's up. Vote to keep going or move on": "Time's up. Vote to keep going or move on";
  - the add box's length: "{n} characters left" when the draft reaches 240, 260 and 280 characters (the counter beneath the box is tied to it but is not a live region);
  - banners, when one appears or changes;
  - outcome lines, copy confirmations and refusals.
- Tap targets are at least 44 by 44 px, `sm` buttons included.
- The page sets `scroll-padding-top` and `scroll-padding-bottom` to the heights of the sticky top bar, status strip, add box and action bar, so a focused control is never hidden under them.
- Colour is never the only signal: each column's state also appears as a word, and pressed choices are also marked with `aria-pressed`.
- Motion follows `prefers-reduced-motion`.
- Contrast meets the design system's rules in all four themes, and `@axe-core/playwright` finds no serious or critical violations in any phase.

## Design-system additions needed

The system has `ModeSwitch`, `Button`, `StateChip`, `Column`, `TopicCard`, `VoteDots`, `VoteBudget`, `DialTimer`, `TimeUpVote`, `TopicInput` and `AttendeeChip`. The MVP also needs:

1. **Sheet:** a bottom sheet on phones and a centred dialog on wide screens, with a title, focus trap, Escape to close and a close button. Used for the share step, the People and Facilitator sheets, the timebox picker, the time-up sheet and confirmations.
2. **Confirm dialog:** a Sheet variant with a body and a button row that puts the danger action last but one and Cancel last.
3. **Banner:** a full-width message with info, warning and error tones and an optional action.
4. **ActionBar:** the facilitator's sticky bottom bar (phone), holding the primary and at most one other button, and side-panel block (wide), holding every button. It hides while the add box has focus on phones.
5. **Status strip:** a one-line, tappable strip with a topic number, truncated text, a compact countdown and an optional chip.
6. **Tabs:** an accessible tab list with counts, for the discussion phase on phones.
7. **Segmented choice:** a single-choice row of buttons, wrapping to two rows on phones, for timeboxes, extensions and the vote allowance.
8. **Switch:** an on/off control with a label and hint.
9. **Badge:** a small label, for "Rehearsal".
10. **QR panel:** a light, high-contrast ground for the QR code in every theme.
11. **`TimeUpVote` with three choices.** `choice` becomes `'extend' | 'none' | 'end'`, it takes `topic`, `choice`, `voted`, `totals` (`{ extend, none, end }`) and `turnout` (a line of text), and its children are the facilitator's decision area. Once a choice is made, or `voted` is true, the choices are disabled. Today it has two choices.
12. **`TopicCard` additions:** an editing state, a "Votes hidden" state for `VoteDots`, and an actions row for "Vote", "Remove vote", "Edit", "Delete" and "Discuss".
13. **`Column` group heading,** for "No votes yet" in To discuss.
14. **Outcome line:** a short-lived, announced line.
15. **Ended summary:** the read-only "Discussed" and "Not discussed" list, which may borrow Party's display face for its heading, as the design system allows.
16. **Select:** a native select with its label above, styled like the text input, for the timer sound.
16. **A select,** for the timer sound, styled like `.rb-input`.
17. **`sm` buttons at least 44 px tall,** with the visual size kept by padding, so every tap target meets 44 px.
18. **A dark-mode fallback in the tokens:** `tokens.css` applies the dark values under `@media (prefers-color-scheme: dark)` when no `data-theme` is set, so pages without JavaScript (the landing page and guide) follow the device.
19. **"More" sheet** for the phone action bar (a Sheet with a list of actions above the Facilitator controls).

**Corrections to the components**, made in the system (items 20 to 25):

20. **`VoteBudget`** reads "{n} votes left", "1 vote left" or "No votes left".
21. **`TopicInput`** holds 280 characters counted as code points, shows "{n} characters left" ("1 character left" at the end) from 240 and ties it to the field, turns line breaks into spaces, has the placeholder "Add a topic" and binds `onInput` for Preact. When a paste or keystroke overflows, only the inserted text is cut. Its README's hint examples are replaced by the one name hint.
22. **`TopicCard`** has no built-ins the MVP doesn't use: no "Author hidden" label, no built-in "Vote" / "Unvote" button (the MVP uses its own actions row with "Vote" and "Remove vote"), no "Merged from n topics" (merging is post-MVP), and its README says 280 characters.
23. **`DialTimer`** shows `m:ss` in both modes. The app passes `sub` written by the [Lengths](#lengths) rules, so rehearsal timeboxes read right. Its warning turns on at `warnAt`, one timebox minute (10 seconds on a rehearsal timer). It reads `0:00` at zero and "Time's up" only once the vote is open (`up`). It sets no live region of its own, leaving the single polite live region to the page.
24. **`bundle.css`** no longer imports Google Fonts. The fonts are self-hosted from the `@fontsource` packages, by the app's build and by the landing page.
25. **The design system README's board section** describes the discussion phase's tabs and status strip on phones.

## Open choices made

1. **Wide screens put the Facilitator controls in the side panel** under the action bar, so the "Facilitator" button is dropped there.
2. **The per-device sound switch lives in the People sheet** for everyone, and also in the Facilitator sheet.
3. **The `ModeSwitch` sits in the top bar on wide screens and in the People sheet on phones,** following the design system's README.
4. **"How Lean Coffee works" opens in a new tab,** because leaving the page would stop the host or drop a participant. The app home's link opens in the same tab, because no meeting is open there.
5. **Deleting a topic is always confirmed.**
6. **The timebox and extension defaults are per device**: the last used, starting at 5 minutes for timeboxes and 3 for extensions.
7. **"Leads" compares Keep going with Move on only;** No preference counts for neither. A tie puts Move on first.
8. **Outcome lines appear only for the two outcomes the design names.** "Start again" while the vote is open reads as keeping going, which it is.
9. **Copy as text** uses the long date ("6 October 2026"), numbers discussed topics, and puts "None" under Discussed when nothing was discussed.
10. **The ended view** shows one list in two parts rather than columns, at every width.
11. **Storage persistence** has a "Dismiss" action on its banner; the over-limits banner stays while the board is over a limit.
12. **Back up meeting file** is confirmed with the existing warning about keys, and is offered in the ended state as the design says.
13. **On phones, "More" replaces the secondaries** whenever a row has two or more, and holds the Facilitator controls too.
14. **Rejoining is per meeting:** the device remembers which meetings it has joined, so a reload skips the join screen.
15. **One name hint** is used on the create form, the join screen and the add box.
