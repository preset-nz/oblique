import type { TextGeometry } from '@/fonts/textGeometry';
import type { TextNode } from './types';
import { buildPath2D, pathCommandsFor } from './vectorRasterize';

/**
 * Rasterise a text node's glyph geometry at the cook target `width`×`height`
 * (= documentSize × level factor). `geometry.paths` are in anchor space, so the
 * node's `position` is applied here with `translate` — moving text never needs
 * Rust. Fill first, then the stroke on top (centred on the outline, round joins).
 * Production-only (needs OffscreenCanvas/Path2D); cook tests inject a fake via
 * `CookDeps.rasterizeText`. Fill and stroke both null yield a transparent raster.
 */
export function rasterizeText(
  node: TextNode,
  geometry: TextGeometry,
  width: number,
  height: number,
  factor: number,
): Uint8Array {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  ctx.setTransform(factor, 0, 0, factor, 0, 0);
  ctx.translate(node.position.x, node.position.y);
  const path = buildPath2D(pathCommandsFor(geometry.paths));

  if (node.fill) {
    ctx.fillStyle = node.fill;
    ctx.fill(path, 'nonzero');
  }
  if (node.stroke && node.stroke.width > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = node.stroke.width;
    ctx.strokeStyle = node.stroke.color;
    ctx.stroke(path);
  }

  const image = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
}
