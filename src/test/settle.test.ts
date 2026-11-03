import { describe, expect, it } from 'vitest';
import { deflate, inflate } from '../protocol/compress';
import { fingerprint, generateSigningKeys, signerFrom } from '../crypto/sign';
import { inFlightWork, settle } from './settle';

describe('settle', () => {
  it('waits for a chain of crypto and compression to finish, however long each step takes', async () => {
    const steps: string[] = [];
    void (async () => {
      const signer = await signerFrom(await generateSigningKeys(false));
      steps.push('keys');
      const packed = await deflate(new TextEncoder().encode(await fingerprint(signer.pub)));
      steps.push('deflated');
      await inflate(packed);
      steps.push('inflated');
    })();
    expect(inFlightWork()).toBeGreaterThan(0);
    await settle();
    expect(steps).toEqual(['keys', 'deflated', 'inflated']);
    expect(inFlightWork()).toBe(0);
  });

  it('counts a stream that fails or is cancelled as finished', async () => {
    await expect(inflate(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
    await expect(inflate(await deflate(new Uint8Array(5000)), 100)).rejects.toThrow('too large');
    await settle();
    expect(inFlightWork()).toBe(0);
  });

  it('returns at once when nothing is in flight', async () => {
    await settle();
    expect(inFlightWork()).toBe(0);
  });

  it('throws naming what is still pending, instead of hanging, when work outlasts its timeout', async () => {
    const stream = new CompressionStream('gzip'); // counts as in flight until its input is closed
    await expect(settle(20)).rejects.toThrow(/still in flight: CompressionStream/);
    await stream.writable.close();
    await stream.readable.cancel();
    await settle();
  });
});
