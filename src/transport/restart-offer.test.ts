import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_GATHER_MS, withRestartableOffers } from './restart-offer';

// A connection that gathers when told: gather() starts a gathering and end() finishes it, as the browser would after
// setLocalDescription of a restart offer.
class FakeConnection extends EventTarget {
  iceGatheringState = 'complete';
  signalingState = 'have-local-offer';
  rolledBack = 0;
  failSetting = false;
  listeners = 0;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) { this.listeners += 1; super.addEventListener(type, listener, options); }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) { this.listeners -= 1; super.removeEventListener(type, listener, options); }
  async createOffer(options?: RTCOfferOptions) { return { type: 'offer', sdp: options?.iceRestart ? 'restart' : 'plain' } as RTCSessionDescriptionInit; }
  async setLocalDescription(description?: { type: string }) { if (this.failSetting) throw new Error('closed'); if (description?.type === 'rollback') this.rolledBack += 1; }
  endCandidates() { this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null })); }
  complete() { this.iceGatheringState = 'complete'; this.dispatchEvent(new Event('icegatheringstatechange')); }
}

const Wrapped = withRestartableOffers(FakeConnection as never) as unknown as typeof FakeConnection;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe('withRestartableOffers', () => {
  it('does not roll back an offer the connection has made', async () => {
    const pc = new Wrapped();
    await pc.setLocalDescription({ type: 'rollback' });
    expect(pc.rolledBack).toBe(0);
  });

  it('passes on a rollback of anything else', async () => {
    const pc = new Wrapped();
    pc.signalingState = 'have-remote-offer';
    await pc.setLocalDescription({ type: 'rollback' });
    expect(pc.rolledBack).toBe(1);
  });

  it('sets a restart offer only once the end of its candidates is reported', async () => {
    const pc = new Wrapped();
    const set = pc.setLocalDescription(await pc.createOffer({ iceRestart: true }) as never);
    expect(await settled(set)).toBe(false);
    pc.endCandidates();
    expect(await settled(set)).toBe(true);
  });

  it('sets a restart offer once gathering completes', async () => {
    const pc = new Wrapped();
    const set = pc.setLocalDescription(await pc.createOffer({ iceRestart: true }) as never);
    expect(await settled(set)).toBe(false);
    pc.complete();
    expect(await settled(set)).toBe(true);
  });

  it('stops waiting for a restart offer after the time limit', async () => {
    const pc = new Wrapped();
    const set = pc.setLocalDescription(await pc.createOffer({ iceRestart: true }) as never);
    await vi.advanceTimersByTimeAsync(RESTART_GATHER_MS - 1);
    expect(await settled(set)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(set)).toBe(true);
  });

  it('does not wait for a plain offer, or for an implicit description', async () => {
    const pc = new Wrapped();
    expect(await settled(pc.setLocalDescription(await pc.createOffer() as never))).toBe(true);
    expect(await settled(pc.setLocalDescription())).toBe(true);
  });

  it('removes its listeners and its timer once a restart offer is set', async () => {
    const pc = new Wrapped();
    const set = pc.setLocalDescription(await pc.createOffer({ iceRestart: true }) as never);
    expect(pc.listeners).toBe(2);
    pc.endCandidates();
    await set;
    expect(pc.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects, and leaves nothing behind, when the connection cannot set the restart offer', async () => {
    const pc = new Wrapped();
    const offer = await pc.createOffer({ iceRestart: true });
    pc.failSetting = true;
    const set = pc.setLocalDescription(offer as never);
    const outcome = set.then(() => 'set', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe('closed');
    await vi.advanceTimersByTimeAsync(RESTART_GATHER_MS);
    expect(pc.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
