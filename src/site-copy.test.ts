import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Pins the hand-written pages to the landing spec (docs/product/landing.md): the hero, the four steps, the Why
// items, the six FAQ answers, the guide body, the head metadata, the section order and the layout limits.
// The hero, steps, Why items, FAQ answers, guide body and head tags are read from the spec itself, so a change to
// either side that the other does not follow fails here. Written out in this file: the section headings (How Lean
// Coffee works, Why Retrobrew, Questions), the guide's title, the guide link beneath the steps, the footer lines
// and the CSS limits.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const spec = read('docs/product/landing.md');
const landing = read('index.html');
const guide = read('lean-coffee/index.html');

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The text a reader sees from a piece of HTML: tags dropped, entities decoded, whitespace squashed. */
function htmlText(html: string): string {
  const bare = html.replace(/<[^>]*>/g, '');
  return squash(bare.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity]));
}

/** The text a reader sees from a piece of the spec's Markdown: emphasis, code ticks and link syntax dropped. */
function markdownText(markdown: string): string {
  return squash(markdown.replace(/\[([^\]]+)\](?:\([^)]*\))?/g, '$1').replace(/\*\*|\*|`/g, ''));
}

/** The spec after `start`, up to the first of `ends` (or the end). */
function section(source: string, start: string, ...ends: string[]): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`Spec has no "${start}"`);
  const rest = source.slice(from + start.length);
  const stops = ends.map((end) => rest.indexOf(end)).filter((at) => at >= 0);
  return stops.length > 0 ? rest.slice(0, Math.min(...stops)) : rest;
}

/** Every `<tag>…</tag>` for the given tags inside some HTML, in order, as visible text. */
function blocks(html: string, tags: string): string[] {
  const pattern = new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'g');
  return [...html.matchAll(pattern)].map((match) => htmlText(match[2]));
}

/** The HTML from an opening marker to the next closing marker. */
function between(html: string, open: string, close: string): string {
  const from = html.indexOf(open);
  if (from < 0) throw new Error(`Page has no ${open}`);
  const to = html.indexOf(close, from);
  if (to < 0) throw new Error(`Page has no ${close} after ${open}`);
  return html.slice(from, to);
}

describe('landing page hero', () => {
  const quote = section(spec, '### 2. Hero', '"Your meetings" in the hero')
    .split('\n')
    .filter((line) => line.startsWith('>'))
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n');
  const parts = quote.split(/\n\s*\n/).map(markdownText);
  const [heading, lede, tagline, , small] = parts;
  const hero = between(landing, '<section class="site-wrap site-section site-hero"', '</section>');

  it('carries the spec heading, lede, tagline and reassurance line', () => {
    // The spec's quote holds five paragraphs: heading, lede, tagline, the button line, the reassurance line.
    expect(parts).toHaveLength(5);
    const paragraphs = blocks(hero, 'p');
    expect(blocks(hero, 'h1')).toEqual([heading]);
    expect(paragraphs[0]).toBe(lede);
    expect(paragraphs[1]).toBe(tagline);
    expect(paragraphs).toContain(small);
  });
});

describe('landing page steps', () => {
  const steps = [...section(spec, '### 3. How Lean Coffee works', '### 4.').matchAll(/^(\d)\. \*\*(.+?)\.\*\* (.+?) \*\(Illustration/gm)].map(
    (match) => ({ number: match[1], title: markdownText(match[2]), body: markdownText(match[3]) }),
  );
  const how = between(landing, '<ol class="site-steps">', '</ol>');
  const items = [...how.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]);

  it('has the spec heading and reads four steps from the spec', () => {
    expect(landing).toContain('<h2 id="how-title">How Lean Coffee works</h2>');
    expect(steps.map((step) => step.number)).toEqual(['1', '2', '3', '4']);
    expect(items).toHaveLength(4);
  });

  it.each([0, 1, 2, 3])('step %i has the spec heading and sentence', (index) => {
    const { number, title, body } = steps[index];
    // Step 4's illustration holds its own h3 and paragraphs; the step's text is always the last of each.
    const headings = blocks(items[index], 'h3');
    expect(headings[headings.length - 1]).toBe(`${number}. ${title}`);
    const paragraphs = blocks(items[index], 'p');
    expect(paragraphs[paragraphs.length - 1]).toBe(body);
  });

  it('keeps each illustration out of the accessibility tree', () => {
    for (const item of items) expect(item).toContain('<div class="site-illo" aria-hidden="true">');
  });

  it('links to the guide beneath the steps', () => {
    expect(landing).toContain('<a class="site-link" href="/lean-coffee/">New to Lean Coffee? Read the short guide</a>');
  });
});

describe('landing page Why Retrobrew', () => {
  const items = [...section(spec, '### 4. Why Retrobrew', '### 5.').matchAll(/^- \*\*(.+?)\.\*\* (.+)$/gm)].map((match) => ({
    title: markdownText(match[1]),
    body: markdownText(match[2]),
  }));
  const why = between(landing, '<ul class="site-why">', '</ul>');
  const listed = [...why.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]);

  it('has the spec heading and four items', () => {
    expect(landing).toContain('<h2 id="why-title">Why Retrobrew</h2>');
    expect(items).toHaveLength(4);
    expect(listed).toHaveLength(4);
  });

  it.each([0, 1, 2, 3])('item %i has the spec title and sentences', (index) => {
    expect(blocks(listed[index], 'h3')).toEqual([items[index].title]);
    expect(blocks(listed[index], 'p')).toEqual([items[index].body]);
  });
});

describe('landing page FAQ', () => {
  const faq = section(spec, '### 5. FAQ', '### 6. Footer');
  const entries = faq
    .split(/\n(?=\*\*[^\n]+\*\*\n)/)
    .filter((chunk) => chunk.startsWith('**'))
    .map((chunk) => {
      const [question, ...rest] = chunk.trim().split('\n');
      const paragraphs = rest
        .join('\n')
        .split(/\n\s*\n/)
        .map(markdownText)
        .filter((text) => text !== '');
      return { question: markdownText(question), paragraphs };
    });
  const faqHtml = between(landing, '<section class="site-wrap site-section site-faq" id="faq"', '</section>');
  const details = [...faqHtml.matchAll(/<details>([\s\S]*?)<\/details>/g)].map((match) => match[1]);

  it('has the spec heading and six questions', () => {
    expect(faqHtml).toContain('<h2 id="faq-title">Questions</h2>');
    expect(entries).toHaveLength(6);
    expect(details).toHaveLength(6);
  });

  it('asks the spec questions in order, each in a summary', () => {
    expect(details.map((detail) => blocks(detail, 'summary')[0])).toEqual(entries.map((entry) => entry.question));
  });

  it.each([0, 1, 2, 3, 4, 5])('answer %i has every spec paragraph, in order', (index) => {
    expect(blocks(details[index], 'p')).toEqual(entries[index].paragraphs);
  });
});

describe('landing page footer', () => {
  const footer = between(landing, '<footer', '</footer>');

  it('has the spec licence line and links', () => {
    expect(blocks(footer, 'p')).toEqual(['Retrobrew is open source under the MIT licence.']);
    expect(blocks(footer, 'li')).toEqual([
      'Source on GitHub',
      'MIT licence',
      'How to run a Lean Coffee',
      'Your meetings',
      'Version %RB_REVISION%',
    ]);
  });
});

describe('the guide body', () => {
  // The spec gives the guide copy between two rules, as Markdown; reduce it to one text per heading, paragraph and bullet.
  const markdown = section(spec, 'The copy:\n\n---\n', '\n---\n');
  const expected = markdown
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => markdownText(line.replace(/^#{1,2} /, '').replace(/^- /, '')));
  const article = between(guide, '<article class="site-article">', '</article>');

  it('reads the spec copy', () => {
    expect(expected[0]).toBe('How to run a Lean Coffee');
    expect(expected.length).toBeGreaterThan(20);
  });

  it('matches the spec heading by heading, paragraph by paragraph and bullet by bullet', () => {
    expect(blocks(article, 'h1|h2|p|li')).toEqual(expected);
  });

  it('ends with the primary button to the create form', () => {
    expect(article.trimEnd().endsWith('<a class="rb-btn rb-btn-primary" href="/app/#start">Start a meeting</a>')).toBe(true);
  });
});

describe('head metadata', () => {
  const headBlocks = [...spec.matchAll(/```html\n([\s\S]*?)```/g)].map((match) =>
    match[1]
      .trim()
      .split('\n')
      .map((line) => line.trim()),
  );
  const [landingTags, guideTags] = headBlocks;
  const head = (html: string) =>
    between(html, '<head>', '</head>')
      .split('\n')
      .map((line) => line.trim());

  it('reads the two blocks from the spec', () => {
    expect(landingTags.length).toBeGreaterThan(10);
    expect(guideTags).toHaveLength(3);
  });

  it('puts every landing tag the spec lists in index.html', () => {
    const lines = head(landing);
    for (const tag of landingTags) expect(lines).toContain(tag);
  });

  it('puts the guide title, description and canonical in the guide', () => {
    const lines = head(guide);
    for (const tag of guideTags) expect(lines).toContain(tag);
  });

  it('gives the guide the landing Open Graph tags with og:url, og:title and og:description changed', () => {
    const [, description, canonical] = guideTags;
    const overrides: Record<string, string> = {
      'og:url': canonical.match(/href="([^"]+)"/)![1],
      'og:title': 'How to run a Lean Coffee',
      'og:description': description.match(/content="([^"]+)"/)![1],
    };
    const expectedTags = landingTags
      .filter((tag) => /^<meta (property="og:|name="twitter:)/.test(tag))
      .map((tag) => {
        const property = tag.match(/property="([^"]+)"/)?.[1];
        return property && property in overrides ? `<meta property="${property}" content="${overrides[property]}">` : tag;
      });
    const lines = head(guide);
    for (const tag of expectedTags) expect(lines).toContain(tag);
  });

  it.each([
    ['index.html', landing],
    ['lean-coffee/index.html', guide],
  ])('%s has the head every page has', (_name, html) => {
    const lines = head(html);
    expect(html).toContain('<html lang="en-GB">');
    expect(lines.filter((line) => line !== '' && line !== '<head>')[0]).toBe('<meta charset="utf-8">');
    expect(lines).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(lines).toContain('<meta name="color-scheme" content="light dark">');
    expect(lines).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(lines).toContain('<link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">');
    expect(lines).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  });
});

describe('landing page structure and layout limits', () => {
  it('orders the sections: top bar, hero, how, why, FAQ, footer', () => {
    const marks = ['<header class="site-wrap site-top">', 'site-hero', 'aria-labelledby="how-title"', 'aria-labelledby="why-title"', 'id="faq"', '<footer'];
    const positions = marks.map((mark) => landing.indexOf(mark));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  const css = read('src/site/site.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) => {
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (match[1].split(',').some((candidate) => candidate.trim() === selector)) return match[2];
    }
    throw new Error(`site.css has no ${selector} rule`);
  };

  it('caps the step illustrations at 280 px', () => {
    expect(rule('.site-illo')).toMatch(/max-width:\s*280px/);
  });

  it('keeps the guide article at most 65 characters wide', () => {
    expect(rule('.site-article')).toMatch(/max-width:\s*65ch/);
  });
});
