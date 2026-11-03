A board column: a StateChip header with a state-colour underline, then its cards.

- Give it `state`; `title` overrides the default label (the product docs' "Topics with no votes" sub-list, say).
- Children are TopicCards. With none it shows `empty`: write what to do next, such as "Vote for topics to line them up here".
- `action` sits at the right of the header (an optional control; the meeting screen keeps Start discussion and End meeting in the facilitator's action bar).
- `focusable` makes the column a focus target (`tabindex="-1"`), for focus to land on when the card that had it is gone.
- `count` is the number on the chip, the topics shown if left out; `null` shows no number (the Discussing column has none).
- `focusFallback` also makes it focusable and the place focus lands when a sheet's opener has gone (see Sheet).
- `note` is a line under the heading, such as "Votes are hidden until the discussion starts".
- Columns sit side by side with `space-6` gaps on wide screens. On phones the topics phase stacks them with `space-6`, and the discussion phase shows one column per tab.
- A `ColumnGroup` heading splits a column into groups, such as "No votes yet" for the To discuss topics nobody has voted for, which sit at its end. It is an `h2`, and the meeting screen shows it only when some topic has votes (with none voted, every topic is unvoted and the heading adds nothing).
