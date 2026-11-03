One tappable line on every tab of the phone's discussion phase, so people always know what is being discussed and how long is left.

- Nothing in Discussing: "Discussion · Next topic coming up". Otherwise the topic's number ("#4"), the start of its text (24 characters, then "…"), and at the end the countdown ("3:12"), "No timer" or "Time's up".
- Its accessible name uses the topic's full text, with "Time's up" or "No timer" when those apply but never the running countdown, so the name doesn't change every second (the page's live region announces the time). Tapping it opens the Discussing tab.
- While the time-up vote is open it carries a small secondary "Vote" chip beside it, which reopens the vote. The chip is its own button, never inside the strip's. `onChip` receives the chip button, so focus can return to it when the sheet closes; `focusFallback` marks the main button as where focus lands if the chip has gone by then (a guest has no action bar to take that role).
- A `state-discussing` edge on the left, `timer-up` once time is up. It sticks to the top of the screen with the tabs.
