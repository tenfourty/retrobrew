import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The crawler files the landing spec names (docs/product/landing.md, "Crawlers"): /robots.txt and /sitemap.xml.
// Checks what the spec requires, not the exact bytes, so formatting changes do not break it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('public/robots.txt', () => {
  const lines = read('public/robots.txt')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('applies to every crawler', () => {
    expect(lines).toContain('User-agent: *');
  });

  it('allows the site and disallows the app', () => {
    expect(lines).toContain('Allow: /');
    expect(lines).toContain('Disallow: /app/');
  });

  it('disallows nothing but the app', () => {
    const disallowed = lines.filter((line) => /^Disallow:/i.test(line));
    expect(disallowed).toEqual(['Disallow: /app/']);
  });

  it('names the sitemap by its full address', () => {
    expect(lines).toContain('Sitemap: https://retrobrew.app/sitemap.xml');
  });
});

describe('public/sitemap.xml', () => {
  const xml = read('public/sitemap.xml');

  it('is a urlset in the sitemaps.org namespace', () => {
    expect(xml).toMatch(/<urlset\b[^>]*\sxmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  });

  it('lists the landing page and the guide, and nothing else', () => {
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].trim());
    expect(locs).toEqual(['https://retrobrew.app/', 'https://retrobrew.app/lean-coffee/']);
  });
});
