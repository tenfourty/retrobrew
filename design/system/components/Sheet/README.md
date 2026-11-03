A panel over the board for one task: inviting people, the people list, the facilitator's controls, the timebox picker, the time-up vote and confirmations.

- Phones: a sheet from the bottom, full width, up to 90% of the screen tall, scrolling inside. Wide screens: a dialog centred over the board, 520px wide at most.
- It is a native modal `<dialog>`: the page behind is inert and dimmed with `scrim`. Escape closes it, Tab and Shift+Tab stay inside it, and on closing, focus goes back to the control that opened it.
- A title in the display face, then the body. It has a ghost "Close" button in its header, unless the sheet ends in its own "Done", "Cancel" or "Close" (`noClose`).
- One sheet at a time. The time-up vote opens above anything else: any other sheet closes first, keeping nothing half-done.
- The page's live region moves into the open sheet before it speaks, because inert content is never read out.
