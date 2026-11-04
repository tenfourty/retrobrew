import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { generateRoomKey } from '../crypto/aead';
import { generateSigningKeys, signerFrom } from '../crypto/sign';
import { buildShareLink, newBoardId } from '../link';
import { qrPath } from './qr-path';

// Rasterises the path the share step draws (the view puts qrPath's `d` straight into an SVG path) and decodes the
// picture with jsQR, a decoder that shares no code with uqr. Dark modules are black on white, as the QR panel shows them.
function decode(text: string): string | null {
  const { size, d } = qrPath(text);
  const scale = 4;
  const width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let py = Number(y) * scale; py < (Number(y) + 1) * scale; py++) {
      for (let px = Number(x) * scale; px < (Number(x) + Number(w)) * scale; px++) {
        const at = (py * width + px) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }
  }
  return jsQR(pixels, width, width)?.data ?? null;
}

async function shareLink(base: string): Promise<string> {
  const signer = await signerFrom(await generateSigningKeys(false));
  return buildShareLink(base, { boardId: newBoardId(), roomKey: generateRoomKey(), hostPub: signer.pub });
}

describe('the share step QR code', () => {
  it('decodes to exactly the share link', async () => {
    const link = await shareLink('https://retrobrew.app/app/');
    expect(link).toContain('#b=');
    expect(decode(link)).toBe(link);
  });

  it('decodes to exactly the share link on a long address', async () => {
    const link = await shareLink(`https://${'a-long-subdomain.'.repeat(8)}example.test/some/deep/path/to/the/app/`);
    expect(link.length).toBeGreaterThan(300);
    expect(decode(link)).toBe(link);
  });

  it('decodes a different link to that link, not this one', async () => {
    const [a, b] = [await shareLink('https://retrobrew.app/app/'), await shareLink('https://retrobrew.app/app/')];
    expect(decode(a)).not.toBe(b);
  });
});
