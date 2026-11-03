# Design

The visual design for Retrobrew. It was made on 30 Sep 2026.

## Start here

- **[system/README.md](system/README.md)** is the design system's rulebook: modes, content rules, colour, type, spacing and the board layout. Read it before building any UI.
- **[system/tokens.json](system/tokens.json)** is the source of truth for colours (four themes), type, spacing, radii and shadows. **[system/tokens.css](system/tokens.css)** is the same tokens as CSS custom properties, generated from it.
- **[system/components/](system/components/)** has the component stylesheet (`bundle.css`), a reference React implementation (`bundle.js`, which assigns `window.Retrobrew`), their types (`index.d.ts`), and a `README.md` of guidelines per component.
- **[system/demo.html](system/demo.html)** is a working board built from the system. Open it in a browser and flip the Business/Party switch.

## The direction in one paragraph

Business at the front, party at the back. There are two modes of one system. **Business** (the Index Card direction) has ruled index cards, navy ink and sticker-dot votes. **Party** (the Riso direction) is a blue, fluorescent pink and yellow risograph with offset shadows. Both modes also share a dial timer and a colour per column. The themes are `business-light`, `business-dark`, `party-light` and `party-dark`, set on `html[data-theme]`. Mode is a per-viewer preference and never part of the board.

## Rules for contributors

- Use the tokens and the `--rb-*` roles from `components/bundle.css`. Never hard-code a colour, font or radius.
- Keep the component names and props in `components/index.d.ts` when you port the components to the chosen stack. The `bundle.js` here is a reference implementation, not a dependency.
- Change `tokens.json` first, then regenerate `tokens.css` with `node scripts/tokens-css.mjs`. `npm test` fails if `tokens.css` is out of step with `tokens.json`.
- Each `components/*/preview.html` is a fragment for a design-system viewer. It won't render on its own, so use `demo.html` to see the components locally.
- The typefaces are self-hosted from the `@fontsource` packages; nothing loads from a font CDN.
