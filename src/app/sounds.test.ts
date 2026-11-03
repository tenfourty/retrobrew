import { describe, expect, it } from 'vitest';
import { SOUND_IDS } from '../engine/types';
import { listenForAudioUnlock, playTimerSound, SOUND_LABEL, SOUNDS, UNLOCK_EVENTS } from './sounds';

// Just enough of Web Audio to see what a sound schedules.
function fakeAudio() {
  const started: Array<{ at: number; freq: number }> = [];
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect: (next: unknown) => next });
  const ctx = {
    currentTime: 5,
    destination: {},
    state: 'running' as AudioContextState,
    resume: async () => undefined,
    createGain: () => ({ ...node(), gain: param() }),
    createOscillator: () => {
      const osc = { ...node(), type: 'sine', frequency: param(), start: (at: number) => started.push({ at, freq: osc.frequency.value }), stop() {} };
      return osc;
    },
  };
  return { ctx: ctx as unknown as AudioContext, started };
}

describe('timer sounds', () => {
  it('has one sound for each sound ID, with its label', () => {
    expect(Object.keys(SOUNDS).sort()).toEqual([...SOUND_IDS].sort());
    expect(SOUND_IDS.map((id) => SOUND_LABEL[id])).toEqual(['Chime', 'Bell', 'Wood block', 'Pips']);
  });

  it('keeps every sound short and quiet', () => {
    for (const notes of Object.values(SOUNDS)) {
      for (const note of notes) {
        expect(note.at + note.length).toBeLessThanOrEqual(2.5);
        expect(note.gain).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('schedules each note from the current time', () => {
    const { ctx, started } = fakeAudio();
    expect(playTimerSound('pips', ctx)).toBe(true);
    expect(started).toEqual([{ at: 5, freq: 1000 }, { at: 5.3, freq: 1000 }, { at: 5.6, freq: 1000 }]);
  });

  it('schedules nothing on a context that is not running', () => {
    const { ctx, started } = fakeAudio();
    (ctx as unknown as { state: string }).state = 'suspended';
    expect(playTimerSound('chime', ctx)).toBe(false);
    expect(started).toEqual([]);
  });

  it('handles a resume that rejects', async () => {
    const { ctx, started } = fakeAudio();
    Object.assign(ctx, { state: 'closed', resume: () => Promise.reject(new Error('closed')) });
    expect(playTimerSound('chime', ctx)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([]);
  });

  it('says so where there is no Web Audio', () => {
    expect(playTimerSound('chime', null)).toBe(false);
  });
});

// An audio context that starts suspended and runs once resume() is allowed to succeed.
function lockedAudio(allowed: () => boolean) {
  const ctx = {
    state: 'suspended' as AudioContextState,
    destination: {},
    resumes: 0,
    createBuffer: () => ({}),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
    resume: async () => {
      ctx.resumes += 1;
      if (allowed()) ctx.state = 'running';
    },
  };
  return ctx;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the iOS audio unlock', () => {
  it('listens for the gestures iOS accepts, not pointerdown', () => {
    expect([...UNLOCK_EVENTS]).toEqual(['pointerup', 'touchend', 'click', 'keydown']);
  });

  it('keeps listening until a gesture leaves the context running', async () => {
    let allowed = false;
    const ctx = lockedAudio(() => allowed);
    const target = new EventTarget();
    listenForAudioUnlock(target, () => ctx as unknown as AudioContext);
    target.dispatchEvent(new Event('pointerup'));
    await settle();
    expect(ctx.resumes).toBe(1);
    allowed = true;
    target.dispatchEvent(new Event('touchend'));
    await settle();
    expect(ctx.state).toBe('running');
    target.dispatchEvent(new Event('click'));
    await settle();
    expect(ctx.resumes).toBe(2);
  });

  it('stops listening on cleanup without touching audio', async () => {
    const ctx = lockedAudio(() => true);
    const target = new EventTarget();
    const stop = listenForAudioUnlock(target, () => ctx as unknown as AudioContext);
    stop();
    target.dispatchEvent(new Event('keydown'));
    await settle();
    expect(ctx.resumes).toBe(0);
  });
});
