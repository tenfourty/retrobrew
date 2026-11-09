import { describe, expect, it } from 'vitest';
import { buildVersion, cap, int, language, pixelRatio, relayHost, stackFrame, tens, type Capped, type Int, type ReportInputs } from './inputs';

describe('the constructors clamp and check', () => {
  it('int clamps to its bounds, floors, and turns NaN into the lower bound', () => {
    expect(int(5.9, 0, 10)).toBe(5);
    expect(int(-3, 0, 10)).toBe(0);
    expect(int(99, 0, 10)).toBe(10);
    expect(int(Number.NaN, 2, 10)).toBe(2);
    expect(int(Infinity, 0, 10)).toBe(0);
  });

  it('cap cuts to the length, drops controls and line breaks, and keeps surrogate pairs whole', () => {
    expect(cap('a\nb\u0000c', 10)).toBe('a bc');
    expect(cap('abcdef', 3)).toBe('abc');
    expect(cap(`ab\u{1f600}`, 3)).toBe('ab');
  });

  it('cap withholds a text whose meeting link the cut would split', () => {
    const text = `${'x'.repeat(10)} b=AbCdEfGh12345678`;
    expect(cap(text, 20)).toBe('[withheld]');
    expect(cap(text, 20)).not.toContain('AbCdEf');
  });

  it('buildVersion keeps only a build ID', () => {
    expect(buildVersion('0123abc')).toBe('0123abc');
    expect(buildVersion('dev')).toBe('dev');
    expect(buildVersion('<script>')).toBe('unknown');
    expect(buildVersion('0123ABC')).toBe('unknown');
  });

  it('language keeps a language and region, and falls back to "und"', () => {
    expect(language('en-GB')).toBe('en-GB');
    expect(language('zh-Hans-CN')).toBe('zh-Hans');
    expect(language('EN')).toBe('und');
    expect(language('')).toBe('und');
  });

  it('relayHost names a built-in relay\'s host and nothing else', () => {
    expect(relayHost('wss://relay.primal.net')).toBe('relay.primal.net');
    expect(relayHost('wss://RELAY.primal.net/')).toBe('relay.primal.net');
    expect(relayHost('wss://relay.primal.net.evil.example')).toBe('other');
    expect(relayHost('ws://localhost:17777')).toBe('other');
    expect(relayHost('not a url')).toBe('other');
    expect(relayHost('ws://127.0.0.1:1', ['ws://127.0.0.1:1'])).toBe('127.0.0.1');
  });

  it('tens and pixelRatio round, clamp and survive NaN', () => {
    expect(tens(362)).toBe(360);
    expect(tens(-5)).toBe(0);
    expect(tens(50_000)).toBe(9990);
    expect(tens(Number.NaN)).toBe(0);
    expect(pixelRatio(2.75)).toBe(3);
    expect(pixelRatio(0.1)).toBe(0.5);
    expect(pixelRatio(20)).toBe(8);
    expect(pixelRatio(Number.NaN)).toBe(1);
  });

  it('stackFrame refuses anything that is not a file name with a line and a column', () => {
    expect(stackFrame('index', 1, 2)).toBe('index:1:2');
    expect(stackFrame('has space', 1, 2)).toBeNull();
    expect(stackFrame('x'.repeat(41), 1, 2)).toBeNull();
    expect(stackFrame('index', 1_000_000, 2)).toBeNull();
    expect(stackFrame('index', -1, 2)).toBeNull();
  });
});

describe('a free string cannot be put in a report input', () => {
  it('is a type error to assign one (checked by tsc)', () => {
    const free: string = 'SENTINEL-topic';
    // @ts-expect-error a plain string is not Capped<200>
    const a: ReportInputs['userAgent'] = free;
    // @ts-expect-error a plain string is not a build version
    const b: ReportInputs['buildVersion'] = free;
    // @ts-expect-error a plain number is not an Int<0, 999>
    const c: ReportInputs['people'] = 3;
    // @ts-expect-error integers with different bounds are different types
    const d: Int<0, 999> = int(1, 0, 9999);
    // @ts-expect-error caps of different lengths are different types
    const e: Capped<120> = cap('x', 200);
    // @ts-expect-error a plain string is not a page
    const f: ReportInputs['page'] = free;
    expect([a, b, c, d, e, f]).toHaveLength(6);
  });
});
