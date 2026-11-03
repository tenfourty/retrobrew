import { SOUND_IDS, type SoundId } from '../engine/types';

// The four timer sounds, made in the browser with Web Audio, so there are no files and no requests
// (docs/product/mvp-screens.md, Timer sound). Each is a few short notes with a quick attack and an exponential decay.

export interface Note {
  freq: number;
  // Seconds after the sound starts.
  at: number;
  length: number;
  type: OscillatorType;
  gain: number;
}

export const SOUNDS: Record<SoundId, Note[]> = {
  chime: [
    { freq: 1318.5, at: 0, length: 1.2, type: 'sine', gain: 0.3 },
    { freq: 987.8, at: 0.25, length: 1.4, type: 'sine', gain: 0.3 },
  ],
  bell: [
    { freq: 880, at: 0, length: 2, type: 'sine', gain: 0.35 },
    { freq: 1760, at: 0, length: 1.2, type: 'sine', gain: 0.12 },
    { freq: 2640, at: 0, length: 0.8, type: 'sine', gain: 0.06 },
  ],
  woodblock: [
    { freq: 820, at: 0, length: 0.09, type: 'triangle', gain: 0.5 },
    { freq: 620, at: 0.16, length: 0.09, type: 'triangle', gain: 0.5 },
  ],
  pips: [0, 0.3, 0.6].map((at): Note => ({ freq: 1000, at, length: 0.12, type: 'sine', gain: 0.3 })),
};

export const SOUND_LABEL: Record<SoundId, string> = { chime: 'Chime', bell: 'Bell', woodblock: 'Wood block', pips: 'Pips' };
export const SOUND_OPTIONS = SOUND_IDS.map((id) => ({ value: id, label: SOUND_LABEL[id] }));

let shared: AudioContext | null = null;

function audio(): AudioContext | null {
  if (shared && shared.state !== 'closed') return shared;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  shared = new Context();
  return shared;
}

// iOS lets a page make sound only after a tap. A tap creates and resumes the audio context and plays one silent
// frame; once the context is running the timer can sound by itself.
export async function unlockAudio(ctx: AudioContext | null = audio()): Promise<void> {
  if (!ctx) return;
  const silence = ctx.createBufferSource();
  silence.buffer = ctx.createBuffer(1, 1, 22050);
  silence.connect(ctx.destination);
  silence.start(0);
  await ctx.resume?.();
}

// The gestures iOS accepts for unlocking audio. A pointerdown isn't one of them: iOS counts the tap when it ends.
export const UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;

// Unlocks audio on each gesture until the context is running, then stops listening. The result stops listening
// early, as an effect's cleanup, and never touches audio.
export function listenForAudioUnlock(target: EventTarget = document, ctx: () => AudioContext | null = audio): () => void {
  const stop = () => { for (const type of UNLOCK_EVENTS) target.removeEventListener(type, unlock); };
  const unlock = () => {
    const context = ctx();
    if (!context) { stop(); return; }
    void unlockAudio(context).catch(() => undefined).then(() => { if (context.state === 'running') stop(); });
  };
  for (const type of UNLOCK_EVENTS) target.addEventListener(type, unlock);
  return stop;
}

// Plays a timer sound now. False where the browser has no Web Audio, or the context is not running (a tap has not
// unlocked it, or the browser suspended it): a suspended context's clock is frozen, so notes scheduled on it would
// sound at the next tap, long after the vote. The time-up sheet is always the main signal.
export function playTimerSound(id: SoundId, ctx: AudioContext | null = audio()): boolean {
  if (!ctx) return false;
  if (ctx.state !== 'running') {
    // Try to wake it for the next vote, but schedule nothing now.
    try { ctx.resume?.()?.catch(() => undefined); } catch { /* handled silently */ }
    return false;
  }
  const now = ctx.currentTime;
  for (const note of SOUNDS[id]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = note.type;
    osc.frequency.value = note.freq;
    gain.gain.setValueAtTime(0.0001, now + note.at);
    gain.gain.exponentialRampToValueAtTime(note.gain, now + note.at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + note.at);
    osc.stop(now + note.at + note.length + 0.05);
  }
  return true;
}
