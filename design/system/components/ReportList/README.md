Labelled rows of a technical report, and below them the exact text that will be sent, for a person who wants to read before they agree. Used in the feedback sheet.

- The rows are a real definition list (`dl`): a small label in `ink-soft` over the value in `ink`, divided by `rule`. Long values wrap anywhere, so a user-agent string or a script path never widens the sheet.
- The JSON sits in a native disclosure ("Show exactly what is sent"). Inside it a `pre` on the `sunken` ground with a `border` edge, set in the mono face, scrolls inside 240px, can be selected, and takes keyboard focus so it can be scrolled without a mouse. An optional small secondary "Copy" button sits under it.
- The rows and the JSON are made from one object by the caller, so they cannot disagree; the component only lays them out.
- Colour and type come from the roles: `--sunken`, `--rule`, `--ink`, `--ink-soft`, `--border`, `--rb-radius-card`, `--rb-font-body`, `--font-mono` and the `--space-*` scale. No mode test and no colour value in its CSS.
- The labels of the disclosure and the block are props, so the component holds no product copy.
