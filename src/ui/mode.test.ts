import { describe, expect, it } from 'vitest';
import { followDevice, themeFor } from './mode';

function fakes(theme: string) {
  const attrs = new Map([['data-theme', theme]]);
  const root = { getAttribute: (n: string) => attrs.get(n) ?? null, setAttribute: (n: string, v: string) => { attrs.set(n, v); } };
  let listener: ((e: { matches: boolean }) => void) | null = null;
  const query = {
    addEventListener: (_t: string, l: (e: { matches: boolean }) => void) => { listener = l; },
    removeEventListener: () => { listener = null; },
  };
  return { attrs, root, query, fire: (matches: boolean) => listener?.({ matches }), listening: () => listener !== null };
}

describe('themeFor', () => {
  it('joins the mode and the shade', () => {
    expect(themeFor('business', false)).toBe('business-light');
    expect(themeFor('party', true)).toBe('party-dark');
  });
});

describe('followDevice', () => {
  it('changes the shade when the device does and keeps the chosen mode', () => {
    const f = fakes('party-light');
    const stop = followDevice(f.root as never, f.query as never);
    f.fire(true);
    expect(f.attrs.get('data-theme')).toBe('party-dark');
    f.fire(false);
    expect(f.attrs.get('data-theme')).toBe('party-light');
    stop();
    expect(f.listening()).toBe(false);
  });
  it('treats anything not party as business', () => {
    const f = fakes('business-light');
    followDevice(f.root as never, f.query as never);
    f.fire(true);
    expect(f.attrs.get('data-theme')).toBe('business-dark');
  });
});
