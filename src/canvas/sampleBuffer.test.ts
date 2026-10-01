import { describe, expect, it } from 'vitest';
import { averageHex, isInsideDocument } from './sampleBuffer';

function image(
  width: number,
  height: number,
  px: (x: number, y: number) => [number, number, number],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('averageHex', () => {
  it('returns the colour of a uniform patch, lower-case', () => {
    const data = image(5, 5, () => [0xab, 0xcd, 0xef]);
    expect(averageHex(data, 5, 5, 2, 2)).toBe('#abcdef');
  });

  it('clamps at a corner: out-of-range taps repeat the edge pixel', () => {
    // Corner pixel (0,0) is white, everything else black. Clamped taps hit
    // (0,0) four times (offsets -1/0 in both axes): 4 * 255 / 9 = 113.33 -> 113 = 0x71.
    const data = image(4, 4, (x, y) => (x === 0 && y === 0 ? [255, 255, 255] : [0, 0, 0]));
    expect(averageHex(data, 4, 4, 0, 0)).toBe('#717171');
  });

  it('clamps along an edge', () => {
    // Left column red; sampling (0, 2) taps column 0 six times, column 1 three times.
    const data = image(4, 5, (x) => (x === 0 ? [255, 0, 0] : [0, 0, 0]));
    expect(averageHex(data, 4, 5, 0, 2)).toBe('#aa0000'); // 6 * 255 / 9 = 170
  });

  it('rounds the channel average to nearest', () => {
    // One tap of 255 among nine: 28.33 -> 28 = 0x1c. Two taps of 255: 56.67 -> 57 = 0x39.
    const one = image(3, 3, (x, y) => (x === 1 && y === 1 ? [255, 255, 255] : [0, 0, 0]));
    expect(averageHex(one, 3, 3, 1, 1)).toBe('#1c1c1c');
    const two = image(3, 3, (x, y) => (y === 1 && x < 2 ? [255, 255, 255] : [0, 0, 0]));
    expect(averageHex(two, 3, 3, 1, 1)).toBe('#393939');
  });

  it('ignores alpha', () => {
    const data = image(3, 3, () => [10, 20, 30]);
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    expect(averageHex(data, 3, 3, 1, 1)).toBe('#0a141e');
  });

  it('samples a single-pixel image', () => {
    expect(
      averageHex(
        image(1, 1, () => [1, 2, 3]),
        1,
        1,
        0,
        0,
      ),
    ).toBe('#010203');
  });
});

describe('isInsideDocument', () => {
  it('is half-open on the far edges', () => {
    expect(isInsideDocument(0, 0, 100, 50)).toBe(true);
    expect(isInsideDocument(99.9, 49.9, 100, 50)).toBe(true);
    expect(isInsideDocument(100, 10, 100, 50)).toBe(false);
    expect(isInsideDocument(-0.1, 10, 100, 50)).toBe(false);
    expect(isInsideDocument(10, 50, 100, 50)).toBe(false);
  });
});
