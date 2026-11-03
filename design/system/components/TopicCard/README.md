A topic on the board: an index card in Business, a riso-printed card in Party.

- Provide `text` (1 to 280 characters), `author`, `number` (the product docs' `#n`), `votes` and `mine` (the viewer's own votes). Leave `votes` out where the rules hide the count.
- Business rules the card like an index card with `rule`; Party drops the ruling, adds a 2px `ink` edge and `shadow-card`, and tilts alternate cards by 0.6°.
- `state` colours the top stripe. `live` marks the single Discussing card with `shadow-live` and straightens it.
- Children sit between the text and the footer, such as the dial timer on the Discussing card.
- `actions` is a row of small buttons under the footer, in this order: "Vote" (secondary), "Remove vote" (ghost), "Edit" (ghost), "Delete" (danger) and, for the facilitator in To discuss, "Discuss" (primary). Discussing and Discussed topics have none.
- `editing` turns the text into a field holding it, with small "Save" (primary) and "Cancel" (ghost) buttons. Enter saves and Escape cancels. The actions row hides while editing.
- `votesHidden` shows only the viewer's own dots, with "Votes hidden" in place of the count.
- `alert` is the refusal from the last action on this topic, in `danger`, until the next action.
- `fresh` bounces the newest dot in. Topic text wraps and is never truncated on its card.
