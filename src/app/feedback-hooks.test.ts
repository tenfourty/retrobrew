import { describe, expect, it } from 'vitest';
import { parseFeedbackHooks } from './feedback-hooks';

describe('parseFeedbackHooks', () => {
  it('reads nothing from nothing, bad JSON or the wrong shape', () => {
    expect(parseFeedbackHooks(null)).toEqual({});
    expect(parseFeedbackHooks('{')).toEqual({});
    expect(parseFeedbackHooks('[1]')).toEqual({});
    expect(parseFeedbackHooks('3')).toEqual({});
  });

  it('keeps a thrown message as text, cut to 200 characters', () => {
    expect(parseFeedbackHooks('{"throwOnLoad":true,"throwMessage":"boom"}')).toEqual({ throwOnLoad: true, throwMessage: 'boom' });
    expect(parseFeedbackHooks(JSON.stringify({ throwMessage: 'x'.repeat(300) })).throwMessage).toHaveLength(200);
    expect(parseFeedbackHooks('{"throwMessage":4}')).toEqual({});
  });

  it('keeps the known settings and drops the rest', () => {
    expect(parseFeedbackHooks('{"throwOnLoad":true,"connectionDelayMs":500,"other":1}')).toEqual({ throwOnLoad: true, connectionDelayMs: 500 });
    expect(parseFeedbackHooks('{"throwOnLoad":"yes","connectionDelayMs":-1}')).toEqual({});
  });
});
