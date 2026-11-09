import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

// The house copy and colour rules (design/system/README.md, "Content fundamentals" and "Colour"), checked on every
// `npm test`. Each rule reports the file, the line and the offending text, so a failure reads as a to-do list.
// Rules apply to words people read: string literals and JSX text in src/app and src/ui, the text and the
// alt/title/aria-label/placeholder/meta content of the hand-written pages, and colour values in the stylesheets.
// Comments and code (`!==`, class names, identifiers) are never read as copy.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Rule = 'exclamation' | 'card' | 'emoji' | 'american' | 'colour';
interface Violation { rule: Rule; file: string; line: number; text: string }
interface Fragment { text: string; line: number }

// ---- Where the rules look -------------------------------------------------------------------------------

// UI strings (src/app/views is inside src/app), the sessions' strings (a refusal reaches onReject through MESSAGES) and the
// engine's refusal copy, which refuse() puts in banners and beside controls.
const TS_COPY_DIRS = ['src/app', 'src/ui', 'src/session', 'src/feedback'];
const TS_COPY_FILES = ['src/engine/messages.ts'];
const HTML_PAGES = ['index.html', 'lean-coffee/index.html', 'public/404.html'];
// Stylesheets that must hold no hard-coded colour. The tokens live in design/system/tokens.css (and the component
// bundle beside it), which is not scanned: everything under src reaches colour only through `var(--...)` roles.
const CSS_DIRS = ['src/ui', 'src/site'];

// Allow-list: a use the rule would flag that is not user-facing copy, or is a decided exception. Each entry names its
// file, the text it forgives (a regular expression on the offending fragment) and why. Add to it only with a reason.
// The last test fails on an entry nothing uses any more, so a fixed line does not leave a stale excuse behind.
interface Allowed { rule: Rule; file: string | RegExp; text: RegExp; why: string }
const ALLOWED: Allowed[] = [
  { rule: 'card', file: /^src\/app\//, text: /^card:/,
    why: 'Refusal-place keys such as `card:{topicId}` are internal identifiers (src/app/refusal-place.ts), never shown.' },
  { rule: 'card', file: 'index.html', text: /index cards and coloured vote dots/,
    why: 'Alt text for og.png, in the words of the design README ("the index-card ritual"). It describes the picture (index cards), not board items; it is kept deliberately.' },
  { rule: 'card', file: 'lean-coffee/index.html', text: /index cards and coloured vote dots/,
    why: 'The same og:image:alt line as index.html.' },
];

// ---- Rule patterns --------------------------------------------------------------------------------------

const CARD = /\bcards?\b/i;
// Pictographs and the variation selector that turns a symbol into an emoji. Plain dots, dashes and ticks pass.
// (c), (R) and TM are pictographs in Unicode but plain legal marks here, and the arrows U+2190 to U+21FF are typography.
const EMOJI = /(?![\u00A9\u00AE\u2122\u2190-\u21FF])\p{Extended_Pictographic}|[\u2605\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u; // plus the star, which Unicode leaves as a plain symbol
// US forms of words the app writes the British way. Whole words, in copy only (never CSS properties or identifiers).
const AMERICAN = /\b(?:colors?|colored|coloring|behaviors?|organiz(?:e|es|ed|ing|ation|ations|er|ers)|centers?|centered|centering|favorites?|canceled|canceling)\b/i;

const CSS_NAMED = ['white', 'black', 'red', 'blue', 'green', 'yellow', 'orange', 'pink', 'purple', 'gray', 'grey', 'navy', 'silver',
  'gold', 'teal', 'maroon', 'olive', 'lime', 'aqua', 'cyan', 'magenta', 'brown', 'coral', 'crimson', 'indigo', 'violet', 'tomato',
  'salmon', 'khaki', 'ivory', 'beige', 'fuchsia', 'lavender', 'turquoise', 'tan', 'plum', 'orchid', 'skyblue', 'royalblue', 'hotpink',
  'deeppink', 'darkblue', 'darkgreen', 'darkred', 'lightblue', 'lightgrey', 'lightgray', 'darkgray', 'darkgrey', 'whitesmoke',
  'rebeccapurple'];
// A name followed by `(` is a CSS function (`tan(45deg)`), not a colour. A bare name that is not a colour (an animation or
// font called `tan`) reads as one: put it in the allow-list with its reason.
const CSS_NAMED_RE = new RegExp(`(?<![\\w-])(?:${CSS_NAMED.join('|')})(?![\\w-])(?!\\s*\\()`, 'i');
const CSS_COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;
const CSS_HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/i;

/** The copy rules applied to one fragment of words: the rules it breaks. */
function copyRulesBroken(fragment: string): Rule[] {
  const broken: Rule[] = [];
  if (fragment.includes('!')) broken.push('exclamation');
  if (CARD.test(fragment)) broken.push('card');
  if (EMOJI.test(fragment)) broken.push('emoji');
  if (AMERICAN.test(fragment)) broken.push('american');
  return broken;
}

// ---- TypeScript and TSX: the strings and text people read ----------------------------------------------
// Parsed with Vite's own parser (`parseAst`, Oxc underneath): TypeScript 7 ships no JavaScript compiler API to import.

// JSX attributes whose value is read by people. Every other attribute (className, id, data-*, type, href ...) is code.
const COPY_ATTRS = new Set(['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt', 'label']);
// What counts as copy: every string literal, template text and JSX text in the scanned files, wherever it sits, so a
// copy-like value in a code position (`{ title: 'Saved!' }`, a returned string) is read as copy; only the positions in
// isCodeString (import paths, keys, comparisons, case labels, directives, TS literal types) and the calls below are not.
// Calls whose arguments, however built (`cx(live && 'rb-card-live')`), name classes, selectors, events or keys, not copy.
// Every string passed to one of these is skipped, so keep the list to names that never take words.
const CODE_CALLS = new Set(['cx', 'classNames', 'classnames', 'querySelector', 'querySelectorAll', 'closest', 'matches', 'getElementById',
  'addEventListener', 'removeEventListener', 'setAttribute', 'getAttribute', 'removeAttribute', 'hasAttribute',
  'getItem', 'setItem', 'removeItem', 'createElement', 'matchMedia', 'dispatchEvent', 'require']);
// add, remove, toggle, contains and replace are code only on a classList (`el.classList.add('x')`); `set.add('Saved')` is not.
const CLASSLIST_CALLS = new Set(['add', 'remove', 'toggle', 'contains', 'replace']);
const COMPARISONS = new Set(['===', '!==', '==', '!=']);

interface AstNode { type: string; start: number; end: number; [key: string]: unknown }
const isNode = (v: unknown): v is AstNode => typeof v === 'object' && v !== null && typeof (v as AstNode).type === 'string';

function calleeName(call: AstNode): string {
  const callee = call.callee as AstNode;
  if (callee.type === 'Identifier') return callee.name as string;
  if (callee.type === 'MemberExpression') return ((callee.property as AstNode).name as string) ?? '';
  return '';
}

/** True for a call whose arguments are code: a CODE_CALLS name, or add/remove/... on a `classList`. */
function isCodeCall(call: AstNode): boolean {
  const name = calleeName(call);
  if (CODE_CALLS.has(name)) return true;
  const callee = call.callee as AstNode;
  if (!CLASSLIST_CALLS.has(name) || callee.type !== 'MemberExpression') return false;
  const object = callee.object as AstNode;
  return object.type === 'MemberExpression' && ((object.property as AstNode).name as string) === 'classList';
}

/** True where a string sits as code (an import path, a key, a comparison, a class name) rather than as words. */
function isCodeString(parent: AstNode | null, key: string): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case 'ImportDeclaration': case 'ExportAllDeclaration': case 'ExportNamedDeclaration': case 'ImportExpression':
    case 'TSExternalModuleReference': case 'TSLiteralType': case 'TSModuleDeclaration': case 'TSTemplateLiteralType':
    case 'TSImportType':
      return true;
    case 'Property': case 'MethodDefinition': case 'PropertyDefinition': case 'TSPropertySignature': case 'TSEnumMember':
      return (key === 'key' || key === 'id') && parent.computed !== true;
    case 'MemberExpression': return key === 'property';
    case 'SwitchCase': return key === 'test';
    case 'ExpressionStatement': return typeof parent.directive === 'string';
    case 'BinaryExpression': return COMPARISONS.has(parent.operator as string);
    default: return false;
  }
}

/** The fragments of user-facing words in TypeScript or TSX source: string literals, template text, JSX text. */
function copyFragments(fileName: string, source: string): Fragment[] {
  return scanSource(fileName, source).copy;
}

// JSX attributes that take a colour. Inline `style` strings are not scanned.
const COLOUR_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'stopColor', 'flood-color', 'floodColor', 'color']);

/** Hard-coded colours on the colour attributes of a TSX file (`<path fill="#fff" />`); `currentColor`, `none` and `var()` pass. */
function colourAttributeFragments(fileName: string, source: string): Fragment[] {
  return scanSource(fileName, source).colours;
}

function scanSource(fileName: string, source: string): { copy: Fragment[]; colours: Fragment[] } {
  const program = parseAst(source, { lang: fileName.endsWith('.tsx') ? 'tsx' : 'ts' }, fileName) as unknown as AstNode;
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineAt = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const out: Fragment[] = [];
  const colours: Fragment[] = [];
  const add = (text: string, start: number) => { if (text.trim()) out.push({ text, line: lineAt(start) }); };
  const visit = (node: AstNode, parent: AstNode | null, key: string): void => {
    if (node.type === 'CallExpression' && isCodeCall(node)) {
      visit(node.callee as AstNode, node, 'callee'); // the arguments name classes and selectors, whatever expression builds them
      return;
    }
    if (node.type === 'JSXAttribute') {
      const name = node.name as AstNode;
      const attr = name.type === 'JSXNamespacedName' ? '' : (name.name as string);
      if (COLOUR_ATTRS.has(attr)) {
        const v = node.value as AstNode | null;
        const literal = v && v.type === 'JSXExpressionContainer' ? (v.expression as AstNode) : v;
        if (literal && literal.type === 'Literal' && typeof literal.value === 'string') {
          for (const f of colourFragments(`${attr}: ${literal.value}`)) colours.push({ text: f.text, line: lineAt(literal.start) });
        }
        return;
      }
      // A plain string on any other attribute is code; an expression there (`label={ok ? 'Yes' : 'No'}`) may still hold words.
      if (!COPY_ATTRS.has(attr) && !(isNode(node.value) && node.value.type === 'JSXExpressionContainer')) return;
    } else if (node.type === 'JSXText') {
      const raw = node.raw as string;
      add(raw, node.start + Math.max(0, raw.search(/\S/)));
      return;
    } else if (node.type === 'Literal') {
      if (typeof node.value === 'string' && !isCodeString(parent, key)) add(node.value, node.start);
      return;
    } else if (node.type === 'TemplateLiteral') {
      if (!isCodeString(parent, key)) {
        for (const q of node.quasis as AstNode[]) {
          const value = q.value as { cooked?: string | null; raw: string };
          add(value.cooked ?? value.raw, q.start);
        }
      }
      for (const e of node.expressions as AstNode[]) visit(e, node, 'expressions'); // strings nested inside the ${...} parts
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v)) v.forEach((c) => { if (isNode(c)) visit(c, node, k); });
      else if (isNode(v)) visit(v, node, k);
    }
  };
  visit(program, null, '');
  return { copy: out, colours };
}

// ---- HTML: text nodes and the attributes people read ---------------------------------------------------

const HTML_COPY_ATTRS = ['alt', 'title', 'aria-label', 'placeholder', 'content'];
// Only these meta tags carry words in `content`; the viewport, colour scheme and the like are code.
const META_COPY = /^<meta\s[^>]*(?:name|property)\s*=\s*["'](?:description|og:title|og:description|og:site_name|og:image:alt|twitter:title|twitter:description|twitter:image:alt)["']/i;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…' };
const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);

/** The fragments of words in a hand-written page. Scripts, styles and comments are blanked first, keeping line numbers. */
function htmlFragments(html: string): Fragment[] {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, blank)
    .replace(/<!doctype[^>]*>/gi, blank);
  const out: Fragment[] = [];
  const lineAt = (pos: number) => clean.slice(0, pos).split('\n').length;
  const addText = (from: number, to: number) => {
    const raw = clean.slice(from, to);
    if (raw.trim()) out.push({ text: decode(raw), line: lineAt(from + raw.search(/\S/)) });
  };
  const tag = /<[^>]*>/g;
  let last = 0;
  for (let m = tag.exec(clean); m; m = tag.exec(clean)) {
    addText(last, m.index);
    last = m.index + m[0].length;
    const attr = new RegExp(`\\s(${HTML_COPY_ATTRS.join('|')})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'gi');
    for (let a = attr.exec(m[0]); a; a = attr.exec(m[0])) {
      const value = a[2] ?? a[3] ?? '';
      if (a[1].toLowerCase() === 'content' && !META_COPY.test(m[0])) continue;
      if (value.trim()) out.push({ text: decode(value), line: lineAt(m.index) });
    }
  }
  addText(last, clean.length);
  return out;
}

// ---- CSS: colour values ----------------------------------------------------------------------------------

/** Hard-coded colours in declaration values: hex, colour functions and named colours. Comments are ignored. */
function colourFragments(css: string): Fragment[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: Fragment[] = [];
  const decl = /([\w-]+)\s*:\s*([^;{}]+)/g;
  for (let m = decl.exec(clean); m; m = decl.exec(clean)) {
    // Blank url(...) and quoted strings, which may hold a fragment such as `#top` or `"red"`.
    const value = m[2].replace(/url\([^)]*\)|"[^"]*"|'[^']*'/gi, (s) => ' '.repeat(s.length));
    const hit = CSS_HEX.exec(value) ?? CSS_COLOUR_FN.exec(value) ?? CSS_NAMED_RE.exec(value);
    if (!hit) continue;
    const at = m.index + m[0].indexOf(m[2]) + hit.index;
    const text = hit[0].endsWith('(') ? `${value.slice(hit.index).split(')')[0]})` : hit[0];
    out.push({ text: `${m[1]}: ${text}`, line: clean.slice(0, at).split('\n').length });
  }
  return out;
}

// ---- Putting the rules together --------------------------------------------------------------------------

function allowed(rule: Rule, file: string, text: string): boolean {
  return ALLOWED.some((a) => a.rule === rule && (typeof a.file === 'string' ? a.file === file : a.file.test(file)) && a.text.test(text));
}

function copyViolations(file: string, fragments: Fragment[]): Violation[] {
  return fragments.flatMap((f) => copyRulesBroken(f.text)
    .filter((rule) => !allowed(rule, file, f.text))
    .map((rule) => ({ rule, file, line: f.line, text: f.text.trim().replace(/\s+/g, ' ') })));
}

function colourViolations(file: string, css: string): Violation[] {
  return colourFragments(css).filter((f) => !allowed('colour', file, f.text))
    .map((f) => ({ rule: 'colour' as const, file, line: f.line, text: f.text }));
}

const describeViolation = (v: Violation) => `${v.file}:${v.line} [${v.rule}] ${JSON.stringify(v.text)}`;

function filesUnder(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = relative(ROOT, join(ROOT, dir, name));
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel, ext));
    else if (ext.test(name)) out.push(rel);
  }
  return out.sort();
}

const isTestFile = (f: string) => /\.test\.tsx?$/.test(f) || f.endsWith('.d.ts');
const copyFiles = () => [...TS_COPY_DIRS.flatMap((d) => filesUnder(d, /\.tsx?$/)), ...TS_COPY_FILES].filter((f) => !isTestFile(f));

// ---- Tests: each rule fires on a bad sample and passes a good one ------------------------------------------

const inTs = (src: string, name = 'src/app/X.tsx') => copyViolations(name, copyFragments(name, src)).map((v) => `${v.rule}:${v.line}:${v.text}`);

describe('copy rules: TypeScript and TSX', () => {
  it('flags an exclamation mark in a string, a template and JSX text, with its line', () => {
    expect(inTs("const a = 1;\nconst msg = 'Saved!';")).toEqual(['exclamation:2:Saved!']);
    expect(inTs('const v = <p>\n  Welcome back!\n</p>;')).toEqual(['exclamation:2:Welcome back!']);
    expect(inTs('const v = <button aria-label="Go now!">x</button>;')).toEqual(['exclamation:1:Go now!']);
    expect(inTs('const v = `Hello ${name}!`;')).toEqual(['exclamation:1:!']);
  });
  it('passes code that merely contains ! and comments that talk about it', () => {
    expect(inTs('if (a !== b && !c) { go(); } // never say "Done!"\n/* Oops! */ const x = y!;')).toEqual([]);
    expect(inTs('const v = <p className="a!" data-x="b!">Saved.</p>;')).toEqual([]);
  });
  it('flags the word card or cards in copy but not an identifier or a class name', () => {
    expect(inTs("const t = 'Remove this card?';")).toEqual(['card:1:Remove this card?']);
    expect(inTs('const v = <p>Your cards are here</p>;')).toEqual(['card:1:Your cards are here']);
    expect(inTs("const v = <p className=\"rb-card\" title=\"Topic\">{cx('card', x)}</p>; const k = kind === 'card'; const c = { card: 1 }; const d = x['card'];")).toEqual([]);
    expect(inTs('const v = <p>Cardinal and discard</p>;')).toEqual([]);
  });
  it('flags an emoji but not arrows, ticks, dots or dashes', () => {
    expect(inTs("const t = 'Done 🎉';")).toEqual(['emoji:1:Done 🎉']);
    expect(inTs("const t = 'Saved ✔️';")).toEqual(['emoji:1:Saved ✔️']);
    expect(inTs("const t = 'Next → · – … ✓ ×';")).toEqual([]);
  });
  it('lets (c), (R), TM and arrows pass but flags real emoji', () => {
    expect(inTs("const t = '© 2026 Retrobrew™ ® ↔ ↗ ↩ ← →';")).toEqual([]);
    for (const e of ['🎉', '✔️', '⚠️', '❤️', '★', '👍']) expect(inTs(`const t = 'Done ${e}';`)).toEqual([`emoji:1:Done ${e}`]);
  });
  it('reads copy-like strings in code positions, such as object values, as copy', () => {
    expect(inTs("const t = { title: 'Saved!' };")).toEqual(['exclamation:1:Saved!']);
    expect(inTs("const t = { 'Saved!': 1 };")).toEqual([]); // a key is code
  });
  it('skips the arguments of class and selector calls and classList.add, but not any add or remove', () => {
    expect(inTs("el.classList.add('card!'); el.classList.toggle('card!'); x.querySelector('.card!');")).toEqual([]);
    expect(inTs("set.add('Saved!'); list.remove('Saved!');")).toEqual(['exclamation:1:Saved!', 'exclamation:1:Saved!']);
  });
  it('flags colour literals on SVG and colour attributes in TSX, but not currentColor or var()', () => {
    const inColour = (src: string) => colourAttributeFragments('src/ui/X.tsx', src).map((f) => `${f.line}:${f.text}`);
    expect(inColour('const v = <path fill="#fff" stroke="red" />;')).toEqual(['1:fill: #fff', '1:stroke: red']);
    expect(inColour('const v = <stop\n stop-color={"rgb(0 0 0)"} />;')).toEqual(['2:stop-color: rgb(0 0 0)']);
    expect(inColour('const v = <path fill="currentColor" stroke="var(--ink)" d="M0 0" className="red" />;')).toEqual([]);
  });
  it('flags US spellings in copy only, not property names or identifiers', () => {
    expect(inTs("const t = 'Pick a color';")).toEqual(['american:1:Pick a color']);
    expect(inTs("const t = 'Canceled. Organize the center.';")).toEqual(['american:1:Canceled. Organize the center.']);
    expect(inTs("const t = 'Favorite behavior';")).toEqual(['american:1:Favorite behavior']);
    expect(inTs("const t = 'Pick a colour'; const s = { color: 1 }; const c = x.color; const centre = 1; // the color\n")).toEqual([]);
  });
  it('does not read import paths as copy', () => {
    expect(inTs("import x from './center!';\nexport * from './color';")).toEqual([]);
  });
});

describe('copy rules: HTML pages', () => {
  const inHtml = (body: string) => copyViolations('index.html', htmlFragments(body)).map((v) => `${v.rule}:${v.line}:${v.text}`);
  it('flags rule breaks in text nodes and in alt, title and meta text, with the line', () => {
    expect(inHtml('<!doctype html>\n<p>Hello!</p>')).toEqual(['exclamation:2:Hello!']);
    expect(inHtml('<p>\nA card for each topic\n</p>')).toEqual(['card:2:A card for each topic']);
    expect(inHtml('<img alt="Party time 🎉" src="a.png">')).toEqual(['emoji:1:Party time 🎉']);
    expect(inHtml('<meta name="description" content="Pick a color">')).toEqual(['american:1:Pick a color']);
    expect(inHtml('<p>We organize</p>')).toEqual(['american:1:We organize']);
  });
  it('passes good copy, and ignores comments, scripts, styles, doctype and code attributes', () => {
    expect(inHtml('<!doctype html><!-- Wow! card -->\n<script>if (a !== b) alert("x!");</script><style>.card{color:red}</style>'
      + '<meta name="viewport" content="width=device-width"><meta name="twitter:card" content="summary">'
      + '<a href="/x!" class="rb-card" data-x="card!">Start a meeting</a>')).toEqual([]);
  });
  it('decodes entities before reading', () => {
    expect(inHtml('<p>Wow&#33;</p>')).toEqual(['exclamation:1:Wow!']);
  });
});

describe('copy rules: stylesheets', () => {
  const inCss = (text: string, file = 'src/ui/app.css') => colourViolations(file, text).map((v) => `${v.line}:${v.text}`);
  it('flags hex, colour functions and named colours, with the line', () => {
    expect(inCss('.a { color: #fff; }')).toEqual(['1:color: #fff']);
    expect(inCss('.a {\n  background: #1a2b3c80;\n}')).toEqual(['2:background: #1a2b3c80']);
    expect(inCss('.a { border: 1px solid rgb(0 0 0 / 40%); }')).toEqual(['1:border: rgb(0 0 0 / 40%)']);
    expect(inCss('.a { fill: hsl(10, 50%, 50%); }')).toEqual(['1:fill: hsl(10, 50%, 50%)']);
    expect(inCss('.a { background: white; }')).toEqual(['1:background: white']);
  });
  it('passes token roles, transparent, currentColor, comments, urls, strings and class names', () => {
    expect(inCss('/* was #fff and red */\n.red-box { color: var(--ink); background: transparent; border-color: currentColor;'
      + ' background-image: url(a.svg#red); content: "red"; }')).toEqual([]);
    expect(inCss('a:hover { outline: 2px solid var(--rb-focus); }')).toEqual([]);
  });
  it('does not read a function call as a colour, but does read a bare name', () => {
    expect(inCss('.a { width: calc(tan(45deg) * 1px); transform: rotate(tan(1)); }')).toEqual([]);
    expect(inCss('.a { animation: tan 1s; }')).toEqual(['1:animation: tan']); // an identifier that is also a colour name goes in the allow-list
  });
  it('forgives a file only through the allow-list', () => {
    expect(inCss('.a { color: #fff; }', 'design/system/tokens.css')).toEqual(['1:color: #fff']);
  });
});

describe('copy rules: scope', () => {
  it('reads the refusal copy in the engine and the strings the sessions produce', () => {
    expect(copyFiles()).toContain('src/engine/messages.ts');
    expect(copyFiles()).toContain('src/session/participant.ts');
    expect(copyFiles().some((f) => f.endsWith('.test.ts'))).toBe(false);
  });
});

describe('copy rules: the real tree', () => {
  it('has no exclamation mark, card, emoji or US spelling in the app copy', () => {
    const files = copyFiles();
    expect(files.length).toBeGreaterThan(40); // the walk found the sources, so a pass means something
    const found = files.flatMap((f) => copyViolations(f, copyFragments(f, readFileSync(join(ROOT, f), 'utf8'))));
    expect(found.map(describeViolation)).toEqual([]);
  });
  it('has none of those in the hand-written pages', () => {
    const found = HTML_PAGES.flatMap((f) => copyViolations(f, htmlFragments(readFileSync(join(ROOT, f), 'utf8'))));
    expect(found.map(describeViolation)).toEqual([]);
  });
  it('has no hard-coded colour in the app and site stylesheets (tokens live in design/system)', () => {
    const files = CSS_DIRS.flatMap((d) => filesUnder(d, /\.css$/));
    expect(files.length).toBeGreaterThan(1);
    const found = files.flatMap((f) => colourViolations(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(found.map(describeViolation)).toEqual([]);
  });
  it('has no hard-coded colour on the SVG and colour attributes of the TSX', () => {
    const found = copyFiles().filter((f) => f.endsWith('.tsx')).flatMap((f) => colourAttributeFragments(f, readFileSync(join(ROOT, f), 'utf8'))
      .filter((c) => !allowed('colour', f, c.text)).map((c) => `${f}:${c.line} [colour] ${JSON.stringify(c.text)}`));
    expect(found).toEqual([]);
  });
  it('keeps every allow-list entry in use, so a fixed line does not leave a stale excuse', () => {
    const fragments = new Map<string, string[]>();
    for (const f of copyFiles()) {
      const source = readFileSync(join(ROOT, f), 'utf8');
      const colours = f.endsWith('.tsx') ? colourAttributeFragments(f, source) : [];
      fragments.set(f, [...copyFragments(f, source), ...colours].map((x) => x.text));
    }
    for (const f of HTML_PAGES) fragments.set(f, htmlFragments(readFileSync(join(ROOT, f), 'utf8')).map((x) => x.text));
    for (const f of CSS_DIRS.flatMap((d) => filesUnder(d, /\.css$/))) {
      fragments.set(f, colourFragments(readFileSync(join(ROOT, f), 'utf8')).map((x) => x.text));
    }
    const unused = ALLOWED.filter((a) => ![...fragments].some(([f, texts]) =>
      (typeof a.file === 'string' ? a.file === f : a.file.test(f)) && texts.some((t) => a.text.test(t))));
    expect(unused.map((a) => `${a.rule} ${String(a.file)} ${a.text}`)).toEqual([]);
  });
});
