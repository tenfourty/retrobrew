import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// The built site may only contact the relays and STUN servers in src/config.ts.
const BANNED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.run', 'esm.sh'];

// A release build must not carry the test relays (VITE_RELAYS is for `vite build --mode e2e` only).
const TEST_RELAYS = ['ws://127.0.0.1', 'ws://localhost'];

// Nor the hooks only browser-battery builds carry: the window hooks (src/app/e2e-hooks.ts) and the forced-state setting
// the tab's sessionStorage holds (rb-e2e-force, src/app/test-hooks.ts). Their reads sit behind a build-time mode check,
// so any other build compiles them out.
// The feedback ones: the tab's sessionStorage setting and window log (rb-e2e-feedback, __rbFeedbackLog), and the stub's
// test routes (/__feedback), which only the dev server and the e2e preview serve.
const E2E_HOOKS = ['__rbRelayHealth', '__rbDirectPeers', 'rb-e2e-force', 'A browser test stopped the meeting from starting', 'rb-e2e-feedback', '__rbFeedbackLog', '/__feedback'];

// What only the feedback feature carries: its send path as a string literal and its sheet and button copy. A build made
// without FEEDBACK_ORIGIN compiles the feature out (src/app/feedback-gate.ts, FEEDBACK_BUILT), so none of it may be in
// the app's scripts; a build made with it must carry the send path. Decided by the same FEEDBACK_ORIGIN the build read.
const FEEDBACK_PATH_LITERAL = /["'`]\/feedback["'`]/;
const FEEDBACK_COPY_MARKER = 'Send feedback';

// Every page the site serves. A page missing from the build is a problem too.
export const PAGES = ['index.html', 'lean-coffee/index.html', 'app/index.html'];

// The public pages carry no app code: only these two small scripts from public/ (docs/product/landing.md).
const PUBLIC_PAGES = ['index.html', 'lean-coffee/index.html'];
const PUBLIC_SCRIPTS = ['legacy-link.js', 'site-mode.js'];

// The repository and licence links are placeholders until launch. RETROBREW_LAUNCH=1 makes them an error.
const PLACEHOLDER_URL = 'https://github.com/';
const BARE_PLACEHOLDER = /https:\/\/github\.com\/(?![\w.~%-])/;

// Our own origin. Canonical and Open Graph URLs name it; nothing else absolute may load.
const OWN_ORIGIN = 'https://retrobrew.app/';

// Tags whose src, href, srcset or data the browser fetches as the page loads.
// Values may be double-quoted, single-quoted or bare, and names are case-insensitive.
const VALUE = String.raw`\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`;
const LOADING_TAG = /<(script|link|img|source|iframe|video|audio|embed|object|image|use)\b[^>]*>/gi;
const URL_ATTR = new RegExp(String.raw`(?<![\w:-])(?:src|href|xlink:href|data|poster)${VALUE}`, 'gi');
const SRCSET_ATTR = new RegExp(String.raw`(?<![\w:-])(?:image)?srcset${VALUE}`, 'gi');
// Meta tags whose content a crawler or a link preview fetches.
const IMAGE_META = /<meta\b[^>]*(?:property|name)\s*=\s*["']?(?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["']?[\s/>][^>]*>/gi;
const CONTENT_ATTR = new RegExp(String.raw`(?<![\w:-])content${VALUE}`, 'i');
// CSS: url(...), @import "..." and the strings inside image-set(...).
const CSS_URL = /url\(\s*["']?([^"')]*)/gi;
const CSS_IMPORT = /@import\s*(?:url\()?\s*["']?([^"';)\s]+)/gi;
const IMAGE_SET = /image-set\(([^)]*)\)/gi;
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

// Browsers drop tabs and newlines and read a backslash as a slash, so "/\host" and "ht\ttps://" are absolute.
const normalise = (url) => url.trim().replace(/[\t\r\n]/g, '').replace(/\\/g, '/');
const foreign = (url) => {
  const clean = normalise(url);
  return ABSOLUTE.test(clean) && !clean.startsWith(OWN_ORIGIN);
};
const value = (match) => match[1] ?? match[2] ?? match[3] ?? '';

function cssProblems(file, text) {
  const hits = [];
  for (const m of text.matchAll(CSS_URL)) if (foreign(m[1])) hits.push(`${file}: loads ${m[1]}`);
  for (const m of text.matchAll(CSS_IMPORT)) if (foreign(m[1])) hits.push(`${file}: loads ${m[1]}`);
  for (const [, body] of text.matchAll(IMAGE_SET)) {
    for (const [, url] of body.matchAll(/["']([^"']*)["']/g)) if (foreign(url)) hits.push(`${file}: loads ${url}`);
  }
  return hits;
}

function markupProblems(file, text) {
  const hits = [];
  for (const [tag] of text.matchAll(LOADING_TAG)) {
    for (const m of tag.matchAll(URL_ATTR)) if (foreign(value(m))) hits.push(`${file}: loads ${value(m)}`);
    for (const m of tag.matchAll(SRCSET_ATTR)) {
      for (const candidate of value(m).split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url && foreign(url)) hits.push(`${file}: loads ${url}`);
      }
    }
  }
  for (const [tag] of text.matchAll(IMAGE_META)) {
    const url = value(tag.match(CONTENT_ATTR) ?? []);
    if (!normalise(url).startsWith(OWN_ORIGIN)) hits.push(`${file}: preview image ${url} is not on ${OWN_ORIGIN}`);
  }
  // <style> blocks, style="…" attributes and SVG all go through the CSS patterns.
  hits.push(...cssProblems(file, text));
  return hits;
}

function appCodeProblems(dir, page, text) {
  const file = join(dir, page);
  const hits = [];
  if (/<script\b[^>]*\stype\s*=\s*["']?module\b/i.test(text)) hits.push(`${file}: a public page loads a module script (app code)`);
  if (/<link\b[^>]*\srel\s*=\s*["']?modulepreload\b/i.test(text)) hits.push(`${file}: a public page preloads a module (app code)`);
  for (const [tag] of text.matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name) => value(tag.match(new RegExp(String.raw`(?<![\w:-])${name}${VALUE}`, 'i')) ?? []).trim().toLowerCase();
    if (attr('rel').split(/\s+/).includes('preload') && attr('as') === 'script') hits.push(`${file}: a public page preloads a script (app code)`);
  }
  for (const [tag] of text.matchAll(/<script\b[^>]*>/gi)) {
    const src = tag.match(new RegExp(String.raw`(?<![\w:-])src${VALUE}`, 'i'));
    if (!src) { hits.push(`${file}: a public page has an inline script`); continue; }
    const written = value(src);
    // Compare the full path, relative to the build root, not just the file name.
    const resolved = posix.normalize(posix.join(posix.dirname(page), normalise(written))).replace(/^\/+/, '');
    if (!PUBLIC_SCRIPTS.includes(resolved)) hits.push(`${file}: a public page loads ${written}`);
  }
  hits.push(...feedbackProblems(file, text));
  return hits;
}

// The public pages and their two scripts stay inert about feedback: the only way in is the /app/#feedback link.
// No request, and no mention of the endpoint path.
function feedbackProblems(file, text) {
  const hits = [];
  if (/\bfetch\s*\(/.test(text)) hits.push(`${file}: a public page calls fetch(`);
  if (/\/feedback\b/.test(text)) hits.push(`${file}: a public page names the /feedback endpoint (only the /app/#feedback link is allowed)`);
  return hits;
}

export function findProblems(dir, feedbackOrigin = process.env.FEEDBACK_ORIGIN ?? '') {
  const hits = [];
  const scripts = [];
  // /version.txt says which build is live; the landing and guide footers link to it.
  const version = join(dir, 'version.txt');
  if (!existsSync(version)) hits.push(`${version}: missing from the build`);
  else if (!readFileSync(version, 'utf8').trim()) hits.push(`${version}: empty`);
  // A production image must name its commit: "unknown" and "dev" are for builds nobody deploys.
  else if (process.env.RETROBREW_LAUNCH === '1' && !/^[0-9a-f]{7,40}$/.test(readFileSync(version, 'utf8').trim())) {
    hits.push(`${version}: not a commit ID (RETROBREW_LAUNCH=1 needs the REVISION build argument)`);
  }
  for (const page of PAGES) if (!existsSync(join(dir, page))) hits.push(`${join(dir, page)}: page missing from the build`);
  for (const page of PUBLIC_PAGES) {
    if (existsSync(join(dir, page))) hits.push(...appCodeProblems(dir, page, readFileSync(join(dir, page), 'utf8')));
  }
  for (const script of PUBLIC_SCRIPTS) {
    if (existsSync(join(dir, script))) hits.push(...feedbackProblems(join(dir, script), readFileSync(join(dir, script), 'utf8')));
  }
  const files = walk(dir);
  for (const file of files.filter((f) => /\.(html|js|css|svg|webmanifest|json|xml)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    for (const host of BANNED_HOSTS) if (text.includes(host)) hits.push(`${file}: ${host}`);
    if (/\.(js|css)$/.test(file) && text.includes('data:font/')) hits.push(`${file}: an inlined font (data:font/)`);
    if (process.env.RETROBREW_LAUNCH === '1' && file.endsWith('.html') && BARE_PLACEHOLDER.test(text)) {
      hits.push(`${file}: still links the placeholder ${PLACEHOLDER_URL} (RETROBREW_LAUNCH=1)`);
    }
    for (const relay of TEST_RELAYS) if (text.includes(relay)) hits.push(`${file}: test relay ${relay}`);
    if (file.endsWith('.js')) scripts.push(text);
    if (file.endsWith('.js') && !feedbackOrigin.trim()) {
      if (FEEDBACK_PATH_LITERAL.test(text)) hits.push(`${file}: the feedback send path in a build without FEEDBACK_ORIGIN (the feature must be compiled out)`);
      if (text.includes(FEEDBACK_COPY_MARKER)) hits.push(`${file}: the feedback copy "${FEEDBACK_COPY_MARKER}" in a build without FEEDBACK_ORIGIN (the feature must be compiled out)`);
    }
    for (const hook of E2E_HOOKS) if (text.includes(hook)) hits.push(`${file}: browser-battery hook ${hook}`);
    if (file.endsWith('.html')) {
      if (text.includes('%RB_')) hits.push(`${file}: an unfilled %RB_…% build value`);
      hits.push(...markupProblems(file, text));
    }
    if (file.endsWith('.svg')) hits.push(...markupProblems(file, text));
    if (file.endsWith('.css')) hits.push(...cssProblems(file, text));
    if (/\.(webmanifest|json)$/.test(file)) {
      for (const [, url] of text.matchAll(/"((?:[a-z][a-z0-9+.\-]*:)?(?:\/|\\){2}[^"]*)"/gi)) if (foreign(url)) hits.push(`${file}: loads ${url}`);
    }
  }
  if (feedbackOrigin.trim() && !scripts.some((t) => FEEDBACK_PATH_LITERAL.test(t))) hits.push(`${dir}: FEEDBACK_ORIGIN is set but no script carries the feedback send path`);
  if (!files.some((f) => f.endsWith('.woff2'))) hits.push(`${dir}: no bundled .woff2 fonts`);
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'dist';
  const hits = findProblems(dir);
  if (hits.length) {
    console.error(`Third-party asset problems in ${dir}:\n${hits.join('\n')}`);
    process.exit(1);
  }
  console.log(`No third-party asset hosts in ${dir}; every page is built, the public pages carry no app code, and fonts are bundled.`);
}
