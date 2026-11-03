import { expect, it } from 'vitest';
import spec from '../../docs/product/lean-coffee-rules.md?raw';
import { MESSAGES } from './messages';

// The rules spec is the source of the wording, so the two can never drift apart.
it('holds exactly the refusal messages of the rules spec, in its order', () => {
  const section = spec.slice(spec.indexOf('## Refusal messages'), spec.indexOf('## Open choices made'));
  const rows = [...section.matchAll(/^\| `(\w+)` \| (.+) \|$/gm)].map(([, key, message]) => [key, message]);
  expect(rows.length).toBeGreaterThan(30);
  expect(Object.entries(MESSAGES)).toEqual(rows);
});
