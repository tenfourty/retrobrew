Retrobrew is a local-first Lean Coffee board. Its look is a mullet: **Business at the front, Party at the back.** One set of components, two personalities, and a switch between them that anyone can flip for their own screen.

- **Business** is the index-card ritual made tidy: ruled cards, navy ink, coloured sticker dots for votes. It is the default and the one to put on a projector or in front of people meeting you for the first time.
- **Party** is a two-ink risograph: riso blue and fluorescent pink with a yellow third pass, offset "misregistered" shadows, fat rounded headings. It is for meetups, retros that need energy, and anyone who flips the switch.

Both modes share the same layout, the same rules from the product docs and the same three borrowed ideas: sticker-dot votes, a dial timer, and a state colour per column.

## Using the system

- Load `tokens.css`, then `components/bundle.css`, then React 18 and `components/bundle.js`. Components are on `window.Retrobrew`.
- The five typefaces are self-hosted: nothing in the system loads from a third-party host. The app bundles them from the `@fontsource` packages (`src/ui/fonts.ts`), and the landing page imports the same packages (`src/site/site.css`). `demo.html` falls back to system fonts.
- Set `data-theme` on `<html>` to one of `business-light`, `business-dark`, `party-light`, `party-dark`. With no stored choice, use `business-light` or `business-dark` from `prefers-color-scheme`.
- With no `data-theme` at all, `tokens.css` follows the device by itself: Business light, or Business dark under `prefers-color-scheme: dark`. Pages that may run without script, such as the landing page, rely on this.
- Style through the `--rb-*` roles in `bundle.css` (`--rb-font-display`, `--rb-font-body`, `--rb-font-num`, `--rb-radius-card`, `--rb-radius-control`, `--rb-card-edge`, `--rb-tilt`, and the type sizes `--rb-title-size`, `--rb-column-size` and `--rb-reading-size`, each with a matching `-line`). They resolve to the right mode for you. Never test the mode in component CSS except where `bundle.css` already does.
- Switch modes with `ModeSwitch` or `Retrobrew.setMode('party')`. It keeps the viewer's light or dark shade and plays the switch animation once.

## Modes and the switch

- Mode is **per viewer**, stored in that viewer's browser. It is never part of the board, so the facilitator's projector can stay in Business while phones run Party. Nothing about the switch syncs over the share link.
- The facilitator may set the board's *suggested* mode for new joiners; a viewer's own choice always wins.
- Put `ModeSwitch` in the top bar beside the board name, and in the People sheet on phones.
- Entering Party jiggles every card and pops the column chips once (`rb-party-burst`). Going back to Business settles them (`rb-business-settle`). Both are skipped under `prefers-reduced-motion`.
- Party moments: even in Business, the end-of-meeting summary may borrow Party's display face for its headline. Keep it to that one moment.

## Content fundamentals

- British English, sentence case everywhere: "To discuss", "Start discussion", "Time's up. Keep going?"
- Use the product docs' words for things people see: topics, votes, Discussing, Discussed, facilitator, actions and learnings. Say "topic", never "card" or "item", in copy.
- Speak to the viewer as "you"; the app never says "I" or "we". "Your name will appear as the author."
- Buttons are verbs: Add topic, Merge topics, Start discussion, End meeting. No exclamation marks, in either mode. Party gets its fun from type and colour, not from jokier copy.
- Empty states say what to do next: "Vote for topics to line them up here."
- No emoji in the UI.

## Colour

- `desk` is the page, `card` holds topics and panels, `sunken` is for inputs. Text is `ink`; secondary text is `ink-soft`. Both reach 4.5:1 on all three grounds in every theme.
- `primary` fills the one next-step button in an area, with `on-primary` text. Business primary is navy; Party primary is riso blue with yellow text (dark: yellow with deep-blue text).
- `accent` is each mode's loud colour, red dot or fluo pink. Use it for fills and marks only; use `accent-ink` when it has to be text.
- Columns each have a state colour: `state-ideas`, `state-todiscuss`, `state-discussing`, `state-discussed`, with matching `on-state-*` for text on a fill. The state also appears as a word, so colour is never the only signal.
- Votes use `dot-1`, `dot-2`, `dot-3` in turn, each ringed with `dot-edge`.
- The timer uses `state-discussing` while running, `timer-warn` in the last minute and `timer-up` at zero.
- `danger` is for destructive actions only. `rule` is decorative ruling and dividers, never a control's only edge; controls use `border` (3:1).
- Focus: a solid 2px `focus` ring, offset 2px, on every interactive element, in every theme.

## Type

- Business: headings in Bricolage Grotesque 800 (`title`, `column`), everything people read in Atkinson Hyperlegible (`topic`, `body`, `meta`, `label`), and the clock in Martian Mono (`timer`, always `mm:ss`).
- Party: headings and the clock in Bagel Fat One (`party-title`, `party-column`, `party-timer`), everything else in DM Sans. Bagel Fat One is for 18px and up only; never set a topic in it.
- Topic text is 16px in both modes and wraps; never truncate a topic on its card.
- Numerals that line up (counts, the clock, vote tallies) use `font-variant-numeric: tabular-nums`.

## Shape, space and depth

- Spacing is a 4px scale: `space-1` between dots, `space-3` inside cards and between them, `space-4` for panels and the phone gutter, `space-6` between columns on desktop, `space-8` between sections.
- Business corners are nearly square: `radius-card-biz` (3px) and `radius-control-biz` (4px). Party goes round: `radius-card-party` (14px) and full pills (`radius-control-party`). Components get these through `--rb-radius-card` and `--rb-radius-control`.
- Depth: Business cards lift softly with `shadow-card`; Party prints a flat offset second ink instead. The Discussing card gets `shadow-live`. Primary buttons carry `shadow-button` in Party, and pressing one knocks it into place.
- Party tilts alternate cards by 0.6° and puts a 6px halftone dot grid on the desk. Business does neither.

## Sheets and dialogs

- Anything that takes over the screen for one task is a `Sheet`: a bottom sheet on phones and a centred dialog on wide screens, dimmed behind with `scrim`. Questions before destructive actions are a `ConfirmDialog`. Never use the browser's `alert()` or `confirm()`.
- One sheet at a time. Sheets trap focus, close with Escape, and return focus to the control that opened them.
- The facilitator's next-step buttons are an `ActionBar` (stacked in the wide side panel, a row with the primary on the right on phones); the phone's "More" sheet lists the rest as an `ActionList`. Key the bar's buttons by slot so focus survives a row change.
- The QR code for a share link sits on a `QrPanel`, which stays light in every theme.
- Connection trouble and other board-wide messages are a `Banner` below the top bar, one at a time.

## Forms

- A field is a `.rb-field`: a `.rb-label` above its `.rb-input`, then an optional `.rb-hint` and an inline `.rb-alert` saying what went wrong ("Enter your name"). The input gets `aria-invalid` and is described by the hint and the alert.
- Every `.rb-input` is at least 44px tall, like every button.
- Errors say what to do, in sentence case with no full stop: "Enter a meeting name", "Add your name first".
- A file input is a visually hidden `<input type="file">` inside a `<label class="rb-btn rb-btn-secondary rb-file">`, so it looks like a button and keeps its focus ring.
- A link that stands on its own line, such as the wordmark or "How Lean Coffee works", is a `.rb-link`, a 44px tap target. Links inside sentences are not.
- A `Badge` (`.rb-badge`) is a small word label beside a name, such as "Rehearsal". It is never a control.

## Accessibility

- One polite live region per page speaks for the whole board: phase changes, a topic starting, the countdown at one timebox minute left, time up, the add box's length marks (240, 260 and 280 characters), outcome lines, copy confirmations and refusals. Components never add live regions of their own; they take a callback or leave it to the page.
- Every control is at least 44 by 44px. Every control has a visible text name; there are no icon-only controls.
- Sheets trap focus, close with Escape and return focus to what opened them.
- Colour is never the only signal: states are words, chosen options carry `aria-pressed` or `aria-selected`, and the timer says "Time's up" once the vote is open (it reads 0:00 until then).
- Hover and pressed states keep their contrast in every theme: in Party a hovered secondary button stays sticker yellow.
- Motion follows `prefers-reduced-motion`.

## Iconography

- There is no icon set yet and no logo; the name is set in type. Set it with `.rb-wordmark`: the display face at its display weight, 28px, tight tracking, in `ink`. Use it for the name in every top bar (the public pages and the app) so they match, and keep it at 28px in both modes. Most controls are text buttons, which suits a board that should be readable from the back of the room.
- Where an icon is needed later, use one outline set at 1.5px stroke in `ink`, the same in both modes. Do not use a coffee cup as the mark.

## The board

- Four columns left to right, in the product docs' order. Only one topic sits in Discussing at a time.
- On phones the topics phase stacks its columns, and the discussion phase puts one column per tab (To discuss, Discussing, Discussed) under a status strip that shows the current topic and its time on every tab. The topic field pins to the bottom of the screen, above the facilitator's action bar.
- The status strip and tabs are `StatusStrip` and `Tabs`; "No votes yet" in To discuss is a `ColumnGroup`. The strip's Vote chip is a separate button beside the strip's own, never inside it.
- The ended board is `EndedSummary`: one list in two parts at every width, "Discussed" numbered and "Not discussed", with headings in Party's display face in both modes.
- The facilitator's controls sit in a side panel on desktop and a sheet on phones, styled as plain `card` panels with `ghost` buttons.
