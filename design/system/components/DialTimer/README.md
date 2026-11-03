The discussion clock: a dial that empties as the timebox runs down, with the time beside it.

- `remaining` and `total` are seconds. Timeboxes are 1, 2, 3, 4, 5, 10, 15, 20 or 30 minutes; on rehearsal boards a timebox minute lasts 10 seconds. The facilitator's clock is the source of truth.
- The time reads `m:ss` in both modes, in tabular numerals: Martian Mono in Business, Bagel Fat One in Party.
- The dial fills with `state-discussing`, turns `timer-warn` from `warnAt` seconds (one timebox minute: 60, or 10 on a rehearsal timer), and `timer-up` with a short ring shake at zero.
- `sub` is written by the caller from the product docs' length rules, such as "of 5 min" or "of 50 s". The timer never rounds a length itself.
- `up` says the time-up vote is open: the label then says "Time's up" in words, so the state is never colour-only. Without `up` the dial reads `0:00` at zero, as the status strip does, until the vote opens.
- It has no live region of its own. The page's single polite live region announces "1 minute left" and time up.
