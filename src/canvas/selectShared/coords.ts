import { applyMatrix, docToLocalMatrix, localToDocMatrix } from '@/scene/maskRasterize';
import { IDENTITY_TRANSFORM_2D, type Point2D, type Transform2D } from '@/scene/types';

/**
 * Document <-> cooked-buffer pixel-space mapping shared by every sidecar
 * selection tool (`select-smart`, `select-colour` — Epic 17). Moved out of
 * `smartSelect/` into this sibling `selectShared/` when 2b's colour-range
 * select landed (colour-range-select.md) so `colourSelect/` importing it
 * doesn't reach into `smartSelect/`'s own folder for generic plumbing.
 * Per segment-to-vector.md's "the client maps document <-> buffer through
 * the node's transform2d and the cook level's factor" — same maths
 * `maskRasterize.ts` and `cook.ts` already use, reused rather than
 * reimplemented per the story's instruction: `docToLocalMatrix` maps
 * document space into the target node's own LOCAL pixel space (its
 * `sourceSize`, or `documentSize` for a vector node), and the cook target
 * buffer is that local space scaled by the resolution factor.
 *
 * `bufferSize` is read from the actual cooked bitmap rather than recomputed
 * via `resolutionFactor('working')`: `computeTargetSize`'s
 * `Math.max(1, Math.round(...))` means the nominal 1/2 factor isn't exact at
 * odd source sizes, and X/Y can round to slightly different effective
 * factors — deriving from the bitmap's own width/height is exact.
 */
export interface BufferFrame {
  /** The target node's own transform2d (identity if absent — same default as everywhere else). */
  transform2d: Transform2D;
  /** The node's own local extent: `sourceSize` for a pixel node, `documentSize` for a vector node. */
  extent: [number, number];
  /** The actual cooked bitmap's pixel dimensions at the level sent to the sidecar. */
  bufferSize: [number, number];
}

export function frameFor(
  extent: [number, number],
  bufferSize: [number, number],
  transform2d: Transform2D | undefined = IDENTITY_TRANSFORM_2D,
): BufferFrame {
  return { transform2d: transform2d ?? IDENTITY_TRANSFORM_2D, extent, bufferSize };
}

/** Document-space point -> the cooked buffer's pixel space. */
export function docToBuffer(doc: Point2D, frame: BufferFrame): Point2D {
  const [ew, eh] = frame.extent;
  const [bw, bh] = frame.bufferSize;
  const m = docToLocalMatrix(frame.transform2d, ew, eh);
  const local = applyMatrix(m, doc.x, doc.y);
  return { x: local.x * (ew === 0 ? 0 : bw / ew), y: local.y * (eh === 0 ? 0 : bh / eh) };
}

/** The cooked buffer's pixel space -> document space (the inverse of `docToBuffer` for the same frame). */
export function bufferToDoc(buf: Point2D, frame: BufferFrame): Point2D {
  const [ew, eh] = frame.extent;
  const [bw, bh] = frame.bufferSize;
  const local = { x: buf.x * (bw === 0 ? 0 : ew / bw), y: buf.y * (bh === 0 ? 0 : eh / bh) };
  const m = localToDocMatrix(frame.transform2d, ew, eh);
  return applyMatrix(m, local.x, local.y);
}

export function docPointsToBuffer(points: Point2D[], frame: BufferFrame): Point2D[] {
  return points.map((p) => docToBuffer(p, frame));
}

export function bufferPolygonsToDoc(polygons: Point2D[][], frame: BufferFrame): Point2D[][] {
  return polygons.map((polygon) => polygon.map((p) => bufferToDoc(p, frame)));
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A document-space box -> its buffer-pixel-space bounding box. Maps all 4
 * corners (not just the two opposite ones) so a rotated/skewed node
 * transform still yields an axis-aligned box in buffer space, which is all
 * `prompt.box` is (segment-to-vector.md's fixed contract).
 */
export function docBoxToBufferBox(box: Box, frame: BufferFrame): Box {
  const corners: Point2D[] = [
    { x: box.x0, y: box.y0 },
    { x: box.x1, y: box.y0 },
    { x: box.x1, y: box.y1 },
    { x: box.x0, y: box.y1 },
  ];
  // Never empty — 4 corners always in, so the null case never fires.
  return bufferBoundingBox(corners, frame) as Box;
}

/** Axis-aligned bounding box of a set of points, whatever space they're already in — no frame, no mapping. */
export function boundingBox(points: Point2D[]): Box | null {
  if (points.length === 0) return null;
  let x0 = points[0].x;
  let y0 = points[0].y;
  let x1 = points[0].x;
  let y1 = points[0].y;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/** Axis-aligned bounding box (buffer pixel space) of a set of document-space points. */
export function bufferBoundingBox(points: Point2D[], frame: BufferFrame): Box | null {
  return boundingBox(docPointsToBuffer(points, frame));
}
