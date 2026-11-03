The discussion phase on phones: one column per tab, "To discuss 3", "Discussing" and "Discussed 2".

- A `role="tablist"` of `role="tab"` buttons, each controlling a `role="tabpanel"`. Every panel stays in the page, hidden unless its tab is selected.
- The selected tab is bold `ink` with a 3px underline in its column's state colour, and `aria-selected="true"`; the others are `ink-soft`.
- Counts sit after the label in tabular numerals and are part of the tab's name.
- Arrow keys move between tabs and select them; Home and End go to the first and last. Only the selected tab is in the Tab order. Each panel has `tabindex="0"`, as its content can be text only.
- Tabs share the width and are 44px tall.
