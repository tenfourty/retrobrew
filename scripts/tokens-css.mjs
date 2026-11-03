import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Writes design/system/tokens.css from design/system/tokens.json. Run: node scripts/tokens-css.mjs
const HEADER = '/* Generated from tokens.json. Do not edit by hand: change tokens.json and regenerate. */';

const declarations = (pairs) => pairs.map(([name, value]) => `--${name}:${value};`).join('');

function themeValues(tokens, theme) {
  return [...tokens.color.tokens, ...tokens.shadow.tokens].map((t) => [t.name, t.value[theme]]);
}

export function tokensCss(tokens) {
  const themes = tokens.color.themes.map((t) => t.id);
  const lines = [HEADER];
  for (const theme of themes) {
    const selector = theme === 'business-light' ? `:root, [data-theme="${theme}"]` : `[data-theme="${theme}"]`;
    lines.push(`${selector}{${declarations(themeValues(tokens, theme))}}`);
  }
  const fixed = [
    ...tokens.spacing.tokens.map((t) => [t.name, t.value]),
    ...tokens.radius.tokens.map((t) => [t.name, t.value]),
    ...Object.entries(tokens.type.families).map(([name, value]) => [`font-${name}`, value]),
  ];
  lines.push(`:root{${declarations(fixed)}}`);
  // The type scale, so pages size text from tokens.json rather than by hand.
  const scale = tokens.type.groups.flatMap((g) => g.styles).flatMap((s) => [[`type-${s.name}-size`, s.fontSize], [`type-${s.name}-line`, s.lineHeight]]);
  lines.push(`:root{${declarations(scale)}}`);
  // Pages that run no script (the landing page and the guide) never set data-theme, so follow the device.
  lines.push(`@media (prefers-color-scheme: dark){:root:not([data-theme]){${declarations(themeValues(tokens, 'business-dark'))}}}`);
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = new URL('../design/system/', import.meta.url);
  const tokens = JSON.parse(readFileSync(new URL('tokens.json', dir), 'utf8'));
  writeFileSync(new URL('tokens.css', dir), tokensCss(tokens));
}
