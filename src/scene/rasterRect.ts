import type { TextGeometry } from '@/fonts/textGeometry';
import type { SceneNode } from './types';
import { isPixelNode, isTextNode, isVectorNode } from './types';
import { vectorContentBounds } from './vectorBounds';

/**
 * Where a layer's cooked bitmap sits, in the layer's own space and in document px
 * (layer-overflow.md). The logical frame (`destSizeFor`, the pivot) is unchanged: this is only
 * the bitmap's placement inside it.
 *
 * - pixel: `{0, 0, sourceSize}`, always;
 * - text and vector: the page, grown on each side the content crosses, so nothing past the page
 *   is lost and moving the layer back on never redraws. A layer that stays on the page gets
 *   exactly the page, so its picture (and any grain read at picture-pixel coordinates) is the
 *   one it always had.
 */
export interface RasterRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Room past the content on a side that crosses the page edge, so a blur or edge noise fits. */
export const OVERFLOW_MARGIN_PX = 64;

/**
 * A grown edge snaps outward to a multiple of this, from the document origin. Without it each
 * keystroke on text that runs off the left or top moves the origin, and the grain swims. A
 * multiple of 8 keeps the origin a whole pixel at every cook level (1/8, 1/2, 1).
 */
export const OVERFLOW_STEP_PX = 64;

/** How far past each page edge a raster may reach, in page sizes. Content further out is cut. */
export const OVERFLOW_CLAMP_PAGES = 1;

/** The layer's logical frame at the origin: `sourceSize` for a pixel layer, the page otherwise. */
export function logicalFrameFor(node: SceneNode, documentSize: [number, number]): RasterRect {
  const [w, h] = isPixelNode(node) ? node.sourceSize : documentSize;
  return { x: 0, y: 0, w, h };
}

export function sameRect(a: RasterRect, b: RasterRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * The content's bounds in the layer's own space: the paths' tight bounds for a vector, the
 * glyph bounds moved by `position` and widened by half the stroke for text (as `nodeFootprint`
 * reads them). `null` when there's nothing to bound, or text without its geometry yet.
 */
function contentBounds(node: SceneNode, textGeometry?: TextGeometry): RasterRect | null {
  if (isVectorNode(node)) return vectorContentBounds(node.paths);
  if (isTextNode(node)) {
    const b = textGeometry?.bounds;
    if (!b) return null;
    const half = node.stroke && node.stroke.width > 0 ? node.stroke.width / 2 : 0;
    return {
      x: b.x + node.position.x - half,
      y: b.y + node.position.y - half,
      w: b.w + 2 * half,
      h: b.h + 2 * half,
    };
  }
  return null;
}

/**
 * One axis of the rect: `[start, end]` of the page `[0, page]`, each end grown only when the
 * content crosses it (by the margin, snapped outward), then clamped to one page beyond.
 */
function axis(lo: number, hi: number, page: number): [number, number] {
  const reach = OVERFLOW_CLAMP_PAGES * page;
  const start =
    lo < 0
      ? Math.max(
          -reach,
          Math.floor((lo - OVERFLOW_MARGIN_PX) / OVERFLOW_STEP_PX) * OVERFLOW_STEP_PX,
        )
      : 0;
  const end =
    hi > page
      ? Math.min(
          page + reach,
          Math.ceil((hi + OVERFLOW_MARGIN_PX) / OVERFLOW_STEP_PX) * OVERFLOW_STEP_PX,
        )
      : page;
  return [start, end];
}

/**
 * The raster rect a layer cooks over (layer-overflow.md §Behaviour). Pure: pixel layers get
 * `sourceSize` at the origin; vector layers read their paths; text reads `textGeometry` and
 * without it is the page.
 */
export function rasterRectFor(
  node: SceneNode,
  documentSize: [number, number],
  textGeometry?: TextGeometry,
): RasterRect {
  const frame = logicalFrameFor(node, documentSize);
  if (isPixelNode(node)) return frame;
  const b = contentBounds(node, textGeometry);
  if (!b) return frame;
  const [x0, x1] = axis(b.x, b.x + b.w, frame.w);
  const [y0, y1] = axis(b.y, b.y + b.h, frame.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
