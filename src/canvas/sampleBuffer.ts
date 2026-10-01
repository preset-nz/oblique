import { resolutionFactorFor } from '@/compositor/composite';
import { DISPLAY_LEVEL } from './paintScene';

function toHex(channel: number): string {
  return channel.toString(16).padStart(2, '0');
}

/**
 * 3x3 average of the RGBA8 pixels around `(x, y)` as `#rrggbb` (lower-case,
 * matching what the native colour swatch emits). Out-of-range neighbours are
 * clamped to the nearest edge pixel, so an edge sample still averages nine
 * taps. Alpha is ignored. Channel sums round half up. `x`/`y` are themselves
 * clamped into the image.
 */
export function averageHex(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): string {
  const cx = Math.min(width - 1, Math.max(0, Math.round(x)));
  const cy = Math.min(height - 1, Math.max(0, Math.round(y)));
  let r = 0;
  let g = 0;
  let b = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const py = Math.min(height - 1, Math.max(0, cy + dy));
    for (let dx = -1; dx <= 1; dx++) {
      const px = Math.min(width - 1, Math.max(0, cx + dx));
      const i = (py * width + px) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
  }
  return `#${toHex(Math.round(r / 9))}${toHex(Math.round(g / 9))}${toHex(Math.round(b / 9))}`;
}

/** Whether a document-space point lies inside the document rect `[0, docW) x [0, docH)`. */
export function isInsideDocument(docX: number, docY: number, docW: number, docH: number): boolean {
  return docX >= 0 && docY >= 0 && docX < docW && docY < docH;
}

/**
 * Samples the display composite `buffer` (what the canvas shows, at
 * `DISPLAY_LEVEL`) at a document-space point: maps it into buffer pixels,
 * reads the 3x3 neighbourhood and averages it. The read rect is clamped to
 * the buffer, so `getImageData` never returns out-of-bounds transparent
 * black; `averageHex` then clamps within that patch, whose edges coincide
 * with the buffer's wherever clamping happened. Null when there's no 2D context.
 */
export function sampleBufferHex(
  buffer: OffscreenCanvas,
  docX: number,
  docY: number,
): string | null {
  const ctx = buffer.getContext('2d');
  if (!ctx) return null;
  const factor = resolutionFactorFor(DISPLAY_LEVEL);
  const bx = Math.min(buffer.width - 1, Math.max(0, Math.round(docX * factor)));
  const by = Math.min(buffer.height - 1, Math.max(0, Math.round(docY * factor)));
  const x0 = Math.max(0, bx - 1);
  const y0 = Math.max(0, by - 1);
  const x1 = Math.min(buffer.width - 1, bx + 1);
  const y1 = Math.min(buffer.height - 1, by + 1);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const { data } = ctx.getImageData(x0, y0, w, h);
  return averageHex(data, w, h, bx - x0, by - y0);
}
