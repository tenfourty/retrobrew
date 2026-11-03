import { encode } from 'uqr';

// A QR code as one SVG path, drawn in the browser by uqr (MIT, bundled, no network). `size` counts modules, the
// 4-module quiet zone included, so the path draws on a size × size grid. Each row's dark runs become one rectangle.
export function qrPath(text: string): { size: number; d: string } {
  const { size, data } = encode(text, { ecc: 'M', border: 4 });
  const parts: string[] = [];
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) { x += 1; continue; }
      const start = x;
      while (x < size && row[x]) x += 1;
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  });
  return { size, d: parts.join('') };
}
