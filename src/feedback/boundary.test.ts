import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// src/feedback/ must not be able to reach the board: it imports only itself and the relay allow-list, and it reads no
// global that names the meeting. The report's inputs come from the app through the types in inputs.ts, and nothing else.

const DIR = 'src/feedback';
const sources = (): Array<{ file: string; code: string }> =>
  readdirSync(DIR)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ file: name, code: readFileSync(join(DIR, name), 'utf8') }));

// Comments carry words like "location" in their prose; the code is what runs.
const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

interface Import { specifier: string; typeOnly: boolean }

function importsOf(code: string): Import[] {
  const found: Import[] = [];
  const text = stripComments(code);
  for (const match of text.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\bfrom\s+['"]([^'"]+)['"]/g)) {
    const [, , type, clause, specifier] = match;
    // `import { type A, type B } from` has no value import in it, so it counts as type-only.
    const names = clause.replace(/[{}]/g, '').split(',').map((part) => part.trim()).filter(Boolean);
    const allTypes = names.length > 0 && names.every((name) => name.startsWith('type '));
    found.push({ specifier, typeOnly: Boolean(type) || allTypes });
  }
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) found.push({ specifier: match[1], typeOnly: false });
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ specifier: match[1], typeOnly: false });
  return found;
}

describe('src/feedback import boundary', () => {
  it('finds the feature\'s files', () => {
    expect(sources().map((s) => s.file)).toEqual(expect.arrayContaining(['schema.ts', 'collect.ts', 'inputs.ts', 'errors.ts', 'send.ts', 'trouble.ts']));
  });

  it('makes no value import except from its own files and ../config', () => {
    for (const { file, code } of sources()) {
      for (const { specifier, typeOnly } of importsOf(code)) {
        if (typeOnly) continue;
        const own = /^\.\/[A-Za-z0-9_-]+$/.test(specifier);
        expect(own || specifier === '../config', `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('imports nothing at all from the engine, session, store, protocol or views, even as a type, except from ../config', () => {
    // A type import is erased, but a type that names the board would invite a field of it into the report.
    for (const { file, code } of sources()) {
      for (const { specifier } of importsOf(code)) {
        expect(specifier, file).not.toMatch(/\.\.\/(engine|session|store|protocol|app|transport|crypto|clock)(\/|$)/);
      }
    }
  });

  it('reads no global that names the meeting, except location in errors.ts', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['document.title', /\bdocument\s*\.\s*title\b/],
      ['document.referrer', /\bdocument\s*\.\s*referrer\b/],
      ['localStorage', /\blocalStorage\b/],
      ['sessionStorage', /\bsessionStorage\b/],
      ['indexedDB', /\bindexedDB\b/],
      ['location', /\blocation\b/],
      ['document.cookie', /\bdocument\s*\.\s*cookie\b/],
    ];
    for (const { file, code } of sources()) {
      const text = stripComments(code);
      for (const [name, pattern] of forbidden) {
        // errors.ts reads location.origin, to keep only frames from our own scripts.
        if (name === 'location' && file === 'errors.ts') continue;
        expect(pattern.test(text), `${file} reads ${name}`).toBe(false);
      }
    }
  });

  it('reads location in errors.ts only for its origin', () => {
    const text = stripComments(sources().find((s) => s.file === 'errors.ts')!.code);
    const reads = [...text.matchAll(/\blocation\b(?!\s*=)\s*\??\.?\s*(\w*)/g)].map((m) => m[1]);
    expect(reads.filter((property) => property !== 'origin' && property !== '')).toEqual([]);
  });

  it('has the stripper working: a comment naming location does not count, code does', () => {
    expect(stripComments('// location here\nconst a = 1;')).not.toContain('location');
    expect(stripComments('const a = location.hash; // x')).toContain('location.hash');
  });

  it('parses imports the way the checks rely on', () => {
    const sample = [
      "import { a } from './x';", "import type { B } from '../engine/types';", "import { type C, type D } from '../session/host';",
      "import { type E, f } from '../store/db';", "import './side';", "export { g } from './y';", "export type { H } from '../protocol/z';",
    ].join('\n');
    expect(importsOf(sample)).toEqual(expect.arrayContaining([
      { specifier: './x', typeOnly: false },
      { specifier: '../engine/types', typeOnly: true },
      { specifier: '../session/host', typeOnly: true },
      { specifier: '../store/db', typeOnly: false },
      { specifier: './side', typeOnly: false },
      { specifier: './y', typeOnly: false },
      { specifier: '../protocol/z', typeOnly: true },
    ]));
  });
});
