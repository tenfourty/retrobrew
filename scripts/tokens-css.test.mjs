import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokensCss } from './tokens-css.mjs';

const read = (path) => readFileSync(new URL(`../design/system/${path}`, import.meta.url), 'utf8');
const tokens = JSON.parse(read('tokens.json'));

describe('tokens.css', () => {
  it('is what tokens.json generates', () => {
    expect(read('tokens.css')).toBe(tokensCss(tokens));
  });

  it('keeps Business light as the default with no data-theme', () => {
    expect(tokensCss(tokens)).toContain(':root, [data-theme="business-light"]{--desk:#eef1f6;');
  });

  it('exposes the type scale for both modes', () => {
    const css = tokensCss(tokens);
    expect(css).toContain('--type-title-size:32px;--type-title-line:36px;');
    expect(css).toContain('--type-party-title-size:36px;--type-party-title-line:38px;');
    expect(css).toContain('--type-topic-size:16px;--type-topic-line:22px;');
  });

  it('follows a dark device with Business dark when no data-theme is set', () => {
    const css = tokensCss(tokens);
    const fallback = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    expect(fallback.startsWith('@media (prefers-color-scheme: dark){:root:not([data-theme]){')).toBe(true);
    for (const t of tokens.color.tokens) expect(fallback).toContain(`--${t.name}:${t.value['business-dark']};`);
    for (const t of tokens.shadow.tokens) expect(fallback).toContain(`--${t.name}:${t.value['business-dark']};`);
  });
});
