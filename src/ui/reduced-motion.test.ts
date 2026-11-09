import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// docs/product/mvp-screens.md, Accessibility: "Motion follows prefers-reduced-motion". Every animation and transition in the
// stylesheets (the dial's ring, the sheets sliding in, the mode switch, the party burst, the outcome line, buttons) must
// either sit inside `@media (prefers-reduced-motion: no-preference)` or be switched off by a rule of the same selector inside
// `@media (prefers-reduced-motion: reduce)`. The reduce override is matched by selector text alone: a selector listed in
// a reduce rule counts, whatever its specificity or its place in the file, so this does not prove the override wins the
// cascade. The browser battery checks the sheets in a real page (meeting-a11y.spec.ts).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STYLESHEETS = ['design/system/components/bundle.css', 'src/ui/app.css', 'src/site/site.css'];
const NO_PREFERENCE = '@media (prefers-reduced-motion: no-preference)';
const REDUCE = '@media (prefers-reduced-motion: reduce)';

interface Block { media: string[]; selector: string; declarations: Map<string, string> }

function parse(css: string, media: string[] = []): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    let depth = 1;
    let close = open + 1;
    while (depth > 0 && close < css.length) {
      if (css[close] === '{') depth++;
      else if (css[close] === '}') depth--;
      close++;
    }
    const header = css.slice(i, open).replace(/^(\s*@(?:import|charset|layer)[^{;]*;)+/, '').trim().replace(/\s+/g, ' ');
    const inner = css.slice(open + 1, close - 1);
    i = close;
    if (header.startsWith('@media')) blocks.push(...parse(inner, [...media, header.replace(/\s*:\s*/g, ': ')]));
    else if (/^@(supports|layer)\b/.test(header)) blocks.push(...parse(inner, media)); // grouping rules hold rules of ours
    else if (header.startsWith('@')) continue; // @keyframes, @font-face: their contents are not rules of ours
    else {
      const declarations = new Map<string, string>();
      for (const part of inner.split(';')) {
        const colon = part.indexOf(':');
        if (colon > 0) declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
      }
      blocks.push({ media, selector: header, declarations });
    }
  }
  return blocks;
}

const MOTION = /^(animation|transition|scroll-behavior)(-|$)/;
const OFF = /^(none|0s|0ms)$/;

function unguardedMotion(css: string): string[] {
  const blocks = parse(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const switchedOff = (selector: string, property: string) => blocks.some((b) =>
    b.media.includes(REDUCE) && b.selector.split(',').map((s) => s.trim()).includes(selector) && OFF.test(b.declarations.get(property) ?? ''));
  const out: string[] = [];
  for (const block of blocks) {
    if (block.media.includes(NO_PREFERENCE) || block.media.includes(REDUCE)) continue;
    for (const [property, value] of block.declarations) {
      if (MOTION.test(property) && !OFF.test(value) && !switchedOff(block.selector, property)) out.push(`${block.selector} { ${property}: ${value} }`);
    }
  }
  return out;
}

describe('reduced motion', () => {
  for (const file of STYLESHEETS) {
    it(`${file}: every animation and transition is off for people who asked for less motion`, () => {
      expect(unguardedMotion(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
    });
  }

  it('finds the dial’s ring, the sheets and the rest where they are guarded, so the check can tell', () => {
    const css = readFileSync(join(ROOT, STYLESHEETS[0]), 'utf8');
    const guarded = parse(css.replace(/\/\*[\s\S]*?\*\//g, '')).filter((b) => b.media.includes(NO_PREFERENCE));
    const selectors = guarded.filter((b) => [...b.declarations.keys()].some((p) => MOTION.test(p))).map((b) => b.selector);
    expect(selectors).toEqual(expect.arrayContaining(['.rb-timer-up .rb-dial', '.rb-sheet[open]', '.rb-outcome']));
    expect(unguardedMotion('.x { animation: spin 1s; } @media (prefers-reduced-motion: no-preference) { .y { animation: spin 1s; } }'))
      .toEqual(['.x { animation: spin 1s }']);
    expect(unguardedMotion('@supports (display: grid) { .s { animation: spin 1s; } } @layer base { .l { transition: color 1s; } }'))
      .toEqual(['.s { animation: spin 1s }', '.l { transition: color 1s }']);
    expect(unguardedMotion('@layer a, b; @media (prefers-reduced-motion: reduce) { @supports (display: grid) { .s { animation: none; } } } @supports (display: grid) { .s { animation: spin 1s; } }')).toEqual([]);
    expect(unguardedMotion('.x { transition: color 1s; } @media (prefers-reduced-motion: reduce) { .x { transition: none; } }')).toEqual([]);
  });
});
