import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProblems, PAGES } from './check-no-third-party.mjs';

// A public page as the build writes it: our two small scripts, our stylesheet, our preview image, a link out to GitHub.
const PUBLIC_PAGE = '<!doctype html><html><head><meta charset="utf-8"><script src="./legacy-link.js"></script><script src="./site-mode.js"></script>'
  + '<link rel="canonical" href="https://retrobrew.app/"><meta property="og:image" content="https://retrobrew.app/og.png">'
  + '<link rel="stylesheet" crossorigin href="./assets/site.css"></head><body><a href="https://github.com/">GitHub</a></body></html>';
const APP_PAGE = '<!doctype html><html><head><script type="module" crossorigin src="../assets/app.js"></script></head><body></body></html>';

let dir;
function site(files) {
  dir = mkdtempSync(join(tmpdir(), 'check-assets-'));
  const pages = Object.fromEntries(PAGES.map((p) => [p, p.startsWith('app/') ? APP_PAGE : p.startsWith('lean-coffee/') ? PUBLIC_PAGE.replaceAll('./', '../') : PUBLIC_PAGE]));
  const all = { 'assets/font.woff2': '', 'assets/site.css': 'body{}', 'assets/app.js': '', 'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'version.txt': '0123456789abcdef0123456789abcdef01234567\n', ...pages, ...files };
  for (const [path, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const problems = (files) => findProblems(site(files)).join('\n');
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('check:assets', () => {
  it('passes a site with every page, its own assets, and links out to GitHub', () => {
    expect(findProblems(site({}))).toEqual([]);
  });

  it('fails when version.txt is missing or empty, and passes when it names a build', () => {
    expect(problems({ 'version.txt': null })).toContain('version.txt: missing from the build');
    expect(problems({ 'version.txt': '' })).toContain('version.txt: empty');
    expect(problems({ 'version.txt': '\n' })).toContain('version.txt: empty');
    expect(findProblems(site({ 'version.txt': 'unknown\n' }))).toEqual([]);
  });

  it('fails when a page is missing from the build', () => {
    expect(problems({ 'lean-coffee/index.html': null })).toContain('lean-coffee/index.html: page missing');
  });

  it('fails a page that loads a script, stylesheet or image from another host', () => {
    const hits = findProblems(site({
      'app/index.html': '<script src="https://cdn.example.com/x.js"></script><link rel="stylesheet" href="//other.example/s.css"><img src="https://img.example/a.png">',
    }));
    expect(hits).toHaveLength(3);
  });

  it('fails an image candidate in srcset from another host', () => {
    expect(problems({ 'app/index.html': '<img src="./a.png" srcset="./a.png 1x, https://img.example/a@2x.png 2x">' })).toContain('loads https://img.example/a@2x.png');
  });

  it('fails an Open Graph or Twitter image on another host', () => {
    expect(problems({ 'app/index.html': '<meta property="og:image" content="https://img.example/og.png">' })).toContain('preview image https://img.example/og.png');
    expect(problems({ 'app/index.html': '<meta name="twitter:image" content="https://img.example/t.png">' })).toContain('preview image https://img.example/t.png');
  });

  it('fails inline styles that load from another host', () => {
    expect(problems({ 'app/index.html': '<style>body{background:url(https://img.example/a.png)}</style>' })).toContain('loads https://img.example/a.png');
    expect(problems({ 'app/index.html': '<div style="background:url(\'//img.example/b.png\')"></div>' })).toContain('loads //img.example/b.png');
  });

  it('fails an SVG that loads from another host', () => {
    expect(problems({ 'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://img.example/a.png"/></svg>' })).toContain('favicon.svg: loads https://img.example/a.png');
  });

  it('fails a banned host anywhere in HTML, JS, CSS or SVG', () => {
    expect(problems({ 'assets/site.css': '@import url("https://fonts.googleapis.com/css2?family=X");' })).toContain('fonts.googleapis.com');
    expect(problems({ 'favicon.svg': '<svg><style>@import "https://fonts.googleapis.com/x";</style></svg>' })).toContain('favicon.svg: fonts.googleapis.com');
  });

  it('fails CSS that loads from any absolute URL', () => {
    expect(problems({ 'assets/site.css': 'body{background:url(https://img.example/bg.png)}' })).toContain('loads https://img.example/bg.png');
  });

  it('fails a build that carries a browser-battery hook', () => {
    expect(problems({ 'assets/app.js': 'globalThis.__rbRelayHealth=()=>[];' })).toContain('assets/app.js: browser-battery hook __rbRelayHealth');
    expect(problems({ 'assets/app.js': 'globalThis.__rbDirectPeers=()=>[];' })).toContain('assets/app.js: browser-battery hook __rbDirectPeers');
    expect(problems({ 'assets/app.js': 'sessionStorage.getItem("rb-e2e-force")' })).toContain('assets/app.js: browser-battery hook rb-e2e-force');
    expect(problems({ 'assets/app.js': 'throw new Error("A browser test stopped the meeting from starting")' })).toContain('assets/app.js: browser-battery hook A browser test stopped the meeting from starting');
  });

  it('fails a build that carries a test relay', () => {
    expect(problems({ 'assets/app.js': 'const relays = ["ws://127.0.0.1:17777"];' })).toContain('test relay ws://127.0.0.1');
    expect(problems({ 'assets/app.js': 'const relays = ["ws://localhost:17777"];' })).toContain('test relay ws://localhost');
  });

  it('fails a public page that loads app code', () => {
    const page = (extra) => PUBLIC_PAGE.replace('</head>', `${extra}</head>`);
    expect(problems({ 'index.html': page('<script type="module" crossorigin src="./assets/app.js"></script>') })).toContain('index.html: a public page loads a module script');
    expect(problems({ 'lean-coffee/index.html': page('<link rel="modulepreload" href="../assets/chunk.js">') })).toContain('lean-coffee/index.html: a public page preloads a module');
    expect(problems({ 'index.html': page('<script src="./assets/app.js"></script>') })).toContain('index.html: a public page loads ./assets/app.js');
    expect(problems({ 'index.html': page('<script>console.log(1)</script>') })).toContain('index.html: a public page has an inline script');
  });

  it('fails a page whose build values were never filled in', () => {
    expect(problems({ 'index.html': '<a href="/version.txt">Version %RB_REVISION%</a>' })).toContain('unfilled');
  });

  it('fails a build with no bundled fonts', () => {
    expect(problems({ 'assets/font.woff2': null })).toContain('no bundled .woff2 fonts');
  });

  it('fails URL( in any case, and image-set and @import strings that carry no url()', () => {
    expect(problems({ 'assets/site.css': 'body{background:URL(https://img.example/a.png)}' })).toContain('loads https://img.example/a.png');
    expect(problems({ 'assets/site.css': '@import "https://css.example/a.css";' })).toContain('loads https://css.example/a.css');
    expect(problems({ 'assets/site.css': "@import 'https://css.example/b.css';" })).toContain('loads https://css.example/b.css');
    expect(problems({ 'assets/site.css': '@import url(https://css.example/c.css);' })).toContain('loads https://css.example/c.css');
    expect(problems({ 'assets/site.css': 'a{background:image-set("https://img.example/s.png" 1x)}' })).toContain('loads https://img.example/s.png');
    expect(problems({ 'app/index.html': "<style>a{background:-webkit-image-set('//img.example/s.png' 1x)}</style>" })).toContain('loads //img.example/s.png');
    expect(problems({ 'favicon.svg': '<svg><style>@import "https://css.example/d.css";</style></svg>' })).toContain('favicon.svg: loads https://css.example/d.css');
  });

  it('fails unquoted attribute values and upper-case tags', () => {
    expect(problems({ 'app/index.html': '<script src=https://cdn.example.com/x.js></script>' })).toContain('loads https://cdn.example.com/x.js');
    expect(problems({ 'app/index.html': '<IMG SRC="https://img.example/u.png">' })).toContain('loads https://img.example/u.png');
    expect(problems({ 'app/index.html': '<meta property=og:image content=https://img.example/o.png>' })).toContain('preview image https://img.example/o.png');
  });

  it('fails imagesrcset on a preload link, and a srcset whose first candidate is foreign', () => {
    expect(problems({ 'app/index.html': '<link rel=preload as=image imagesrcset="https://img.example/p.png 1x">' })).toContain('loads https://img.example/p.png');
    expect(problems({ 'app/index.html': '<img srcset="https://img.example/first.png 1x, ./a.png 2x">' })).toContain('loads https://img.example/first.png');
    expect(problems({ 'app/index.html': '<picture><source srcset="https://img.example/src.webp"></picture>' })).toContain('loads https://img.example/src.webp');
  });

  it('fails use, video poster and other loading tags that point elsewhere', () => {
    expect(problems({ 'favicon.svg': '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://img.example/s.svg#a"/></svg>' })).toContain('loads https://img.example/s.svg#a');
    expect(problems({ 'app/index.html': '<video poster="https://img.example/v.png"></video>' })).toContain('loads https://img.example/v.png');
  });

  it('fails backslash, tab and newline tricks that the browser reads as an absolute URL', () => {
    expect(problems({ 'app/index.html': '<img src="/\\img.example/a.png">' })).toContain('loads');
    expect(problems({ 'app/index.html': '<img src="\\\\img.example/a.png">' })).toContain('loads');
    expect(problems({ 'app/index.html': '<img src="ht\ttps://img.example/a.png">' })).toContain('loads');
    expect(problems({ 'assets/site.css': 'a{background:url(/\\img.example/a.png)}' })).toContain('loads');
  });

  it('fails module scripts and modulepreload written without quotes or in capitals on a public page', () => {
    const page = (extra) => PUBLIC_PAGE.replace('</head>', `${extra}</head>`);
    expect(problems({ 'index.html': page('<script type=module src=./legacy-link.js></script>') })).toContain('a public page loads a module script');
    expect(problems({ 'index.html': page('<LINK REL=modulepreload HREF=./x.js>') })).toContain('a public page preloads a module');
  });

  it('allows the two public scripts only at their real paths', () => {
    expect(problems({ 'lean-coffee/index.html': PUBLIC_PAGE.replace('<script src="./legacy-link.js"></script>', '').replaceAll('./', '../') })).toBe('');
    expect(problems({ 'lean-coffee/index.html': PUBLIC_PAGE })).toContain('lean-coffee/index.html: a public page loads ./legacy-link.js');
    expect(problems({ 'index.html': PUBLIC_PAGE.replace('./legacy-link.js', './assets/legacy-link.js') })).toContain('a public page loads ./assets/legacy-link.js');
  });

  it('scans manifests, JSON and XML files too', () => {
    expect(problems({ 'site.webmanifest': '{"icons":[{"src":"https://img.example/i.png"}]}' })).toContain('site.webmanifest: loads https://img.example/i.png');
    expect(problems({ 'x.json': '{"u":"ws://127.0.0.1:1"}' })).toContain('x.json: test relay ws://127.0.0.1');
    expect(problems({ 'sitemap.xml': '<a>https://unpkg.com/x</a>' })).toContain('sitemap.xml: unpkg.com');
  });

  it('fails CSS or JS that inlines a font as a data: URL', () => {
    expect(problems({ 'assets/site.css': '@font-face{src:url(data:font/woff;base64,AAAA)}' })).toContain('assets/site.css: an inlined font (data:font/)');
    expect(problems({ 'assets/app.js': 'const f="data:font/woff2;base64,AAAA"' })).toContain('assets/app.js: an inlined font (data:font/)');
  });

  it('fails a public page that preloads a script, whatever the attribute order or quoting', () => {
    for (const tag of ['<link rel="preload" as="script" href="./a.js">', '<link as="script" href="./a.js" rel="preload">', '<link rel=preload as=script href=./a.js>', "<link href='./a.js' as='script' rel='preload'>", '<LINK REL="PRELOAD" AS="SCRIPT" href="./a.js">']) {
      expect(problems({ 'index.html': PUBLIC_PAGE.replace('</head>', `${tag}</head>`) }), tag).toContain('a public page preloads a script (app code)');
    }
    expect(problems({ 'index.html': PUBLIC_PAGE.replace('</head>', '<link rel="preload" as="font" href="./f.woff2" crossorigin></head>') })).not.toContain('preloads a script');
  });

  it('fails the bare GitHub URL only when RETROBREW_LAUNCH=1', () => {
    const files = { 'index.html': PUBLIC_PAGE };
    const saved = process.env.RETROBREW_LAUNCH;
    try {
      delete process.env.RETROBREW_LAUNCH;
      expect(problems(files)).toBe('');
      process.env.RETROBREW_LAUNCH = '1';
      expect(problems(files)).toContain('index.html: still links the placeholder https://github.com/');
      const real = PUBLIC_PAGE.replace('https://github.com/"', 'https://github.com/retrobrew/retrobrew"');
      expect(problems({ 'index.html': real, 'lean-coffee/index.html': real.replaceAll('./', '../') })).toBe('');
    } finally {
      if (saved === undefined) delete process.env.RETROBREW_LAUNCH; else process.env.RETROBREW_LAUNCH = saved;
    }
  });
});
