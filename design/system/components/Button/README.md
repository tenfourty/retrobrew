Buttons for every command on the board.

- `primary`: one per area for the next step in the flow (Add topic, Start discussion, End meeting). `primary` on `on-primary`, with `shadow-button` in Party.
- `secondary`: other commands (Merge topics, +1 min). Outlined on the card ground in both modes; Party does not fill it, so the filled `primary` is the one that stands out.
- `ghost`: low-weight commands inside cards and menus.
- `danger`: Delete topic, Reset all votes, End meeting, Remove attendee, Clear board. Always followed by an in-page confirmation, never a browser dialog.
- `size="sm"` inside cards and the timer.
- Every button, `sm` included, is at least 44px tall, so it is a comfortable tap target. `sm` keeps its smaller type and side padding.
- Labels are verbs in sentence case taken from the product docs: "Start discussion", not "START" or "Let's go!".
