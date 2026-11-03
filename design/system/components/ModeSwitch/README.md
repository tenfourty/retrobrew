The Business/Party toggle that flips the whole app between its two personalities.

- Place one in the board's top bar, next to the board name. Participants get their own on the profile sheet.
- Mode is a per-viewer preference: the facilitator's projector can stay in Business while phones run Party. Store it in the viewer's browser, never on the board.
- Uncontrolled by default: it swaps the `business-`/`party-` prefix of `html[data-theme]` and keeps the viewer's light or dark shade. Pass `mode` and `onChange` to control it, and `applyToPage={false}` to stop it touching the page.
- Entering Party jiggles every card and pops the column chips once; returning to Business settles them. Both are skipped under `prefers-reduced-motion`.
- Label is always the two words "Business" and "Party", each set in its own mode's display face.
- It is a 44px tap target, like every button.
