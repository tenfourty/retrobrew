import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { tokensCss } from './tokens-css.mjs';

// Draws the public pages' static images from the design system, into public/:
// favicon.svg, favicon.png (32 px), apple-touch-icon.png (180 px) and og.png (1200 × 630,
// from the Cover, in Business light). Run after changing the tokens: node scripts/site-images.mjs
// The images are committed; the build only copies them.

const root = new URL('../', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('design/system/tokens.json', root), 'utf8'));
const colour = (name) => tokens.color.tokens.find((t) => t.name === name).value['business-light'];

// The mark: a navy index card with three sticker dots. No coffee cup (design/system/README.md).
export function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect x="2" y="2" width="28" height="28" rx="3" fill="${colour('primary')}"/>
<circle cx="9.5" cy="20" r="4.5" fill="${colour('dot-1')}"/>
<circle cx="16" cy="12" r="4.5" fill="${colour('dot-2')}"/>
<circle cx="22.5" cy="20" r="4.5" fill="${colour('dot-3')}"/>
</svg>
`;
}

const font = (path) => pathToFileURL(fileURLToPath(new URL(`node_modules/${path}`, root))).href;

// The Cover (design/system/components/Cover/preview.html) recomposed as a 1200 × 630 card:
// the wordmark and tagline centred on the left, and the Cover's art cropped to its own bounds
// on the right, with every mark at least 80 px inside every edge. Unlike the Cover, nothing
// bleeds off the edge, because previews crop social images differently.
function ogHtml() {
  return `<!doctype html><html data-theme="business-light"><head><meta charset="utf-8"><style>
${tokensCss(tokens)}
@font-face { font-family: "Bricolage Grotesque"; font-weight: 800; src: url("${font('@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-800-normal.woff2')}") format("woff2"); }
@font-face { font-family: "Atkinson Hyperlegible"; font-weight: 400; src: url("${font('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2')}") format("woff2"); }
html, body { margin: 0; background: var(--desk); }
.cv { box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 48px; width: 1200px; height: 630px; padding: 80px 88px; overflow: hidden; background: var(--desk); }
.cv svg { flex: none; display: block; }
.slab { fill: var(--primary); }
.cut { stroke: var(--desk); stroke-width: 2; }
.pop { fill: var(--accent); }
.pass { fill: var(--dot-3); }
.live { fill: var(--state-discussing); }
.d1 { fill: var(--dot-1); } .d2 { fill: var(--dot-2); } .d3 { fill: var(--dot-3); }
.dot { stroke: var(--dot-edge); stroke-width: 1; }
.txt { flex: none; }
.name { margin: 0; font: 800 96px/.92 var(--font-display); letter-spacing: -0.03em; color: var(--ink); }
.tag { margin: 20px 0 0; font: 400 30px/1.3 var(--font-body); color: var(--ink-soft); }
</style></head><body><div class="cv">
<div class="txt"><h1 class="name">Retrobrew</h1><p class="tag">Let the room set the agenda</p></div>
<!-- The Cover's art spans x 512 to 984 and y 24 to 280; the view box adds 4 px round it. -->
<svg width="480" height="264" viewBox="508 20 480 264" aria-hidden="true">
<rect class="slab" x="512" y="40" width="208" height="224" rx="3"/>
<line class="cut" x1="512" y1="106" x2="720" y2="106"/><line class="cut" x1="512" y1="128" x2="720" y2="128"/>
<line class="cut" x1="512" y1="150" x2="720" y2="150"/><line class="cut" x1="512" y1="172" x2="720" y2="172"/>
<rect class="pass" x="752" y="32" width="176" height="144" rx="14"/><rect class="pop" x="744" y="24" width="176" height="144" rx="14"/>
<rect class="live" x="744" y="192" width="112" height="80" rx="14"/><rect class="pass" x="872" y="200" width="112" height="80" rx="14"/>
<circle class="dot d1" cx="600" cy="222" r="12"/><circle class="dot d2" cx="624" cy="222" r="12"/><circle class="dot d3" cx="648" cy="222" r="12"/>
<circle class="dot d1" cx="696" cy="68" r="12"/><circle class="dot d3" cx="720" cy="68" r="12"/><circle class="dot d2" cx="744" cy="68" r="12"/>
<circle class="dot d2" cx="792" cy="120" r="12"/><circle class="dot d1" cx="816" cy="120" r="12"/><circle class="dot d3" cx="840" cy="120" r="12"/>
</svg>
</div></body></html>`;
}

async function open(browser, htmlFile, size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  // Nothing leaves this machine: only the local files load.
  await page.route('**/*', (route) => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
  await page.goto(pathToFileURL(htmlFile).href);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (name) => fileURLToPath(new URL(`public/${name}`, root));
  mkdirSync(fileURLToPath(new URL('public/', root)), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'retrobrew-images-'));
  const browser = await chromium.launch();
  try {
    writeFileSync(out('favicon.svg'), faviconSvg());
    const iconHtml = join(work, 'icon.html');
    writeFileSync(iconHtml, `<!doctype html><html><body style="margin:0"><img src="${pathToFileURL(out('favicon.svg')).href}" style="display:block;width:100vw;height:100vh"></body></html>`);
    for (const [name, px] of [['favicon.png', 32], ['apple-touch-icon.png', 180]]) {
      const page = await open(browser, iconHtml, { width: px, height: px });
      await page.screenshot({ path: out(name), omitBackground: name === 'favicon.png' });
      await page.close();
    }
    const og = join(work, 'og.html');
    writeFileSync(og, ogHtml());
    const page = await open(browser, og, { width: 1200, height: 630 });
    await page.screenshot({ path: out('og.png') });
    await page.close();
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}
