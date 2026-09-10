import type { AnchorPoint, Point2D, VectorPath } from '@/scene/types';
import { buildPath2D, pathCommandsFor } from '@/scene/vectorRasterize';
import { type Box, type BufferFrame, boundingBox, docToBuffer } from './coords';

/**
 * The outline prompt (segment-to-vector.md, Georg 2026-09-10: "can I also
 * draw a vector outline and SAM then finds the object inside?"): switching
 * to `select-smart` while a marquee is active, or with a vector node
 * selected, seeds the first request from that shape's bounding box.
 *
 * The seeded box is DOCUMENT space, same as everything else
 * `SmartSelectState` holds (`state.ts`'s own contract) — `controller.ts`'s
 * `fire()` is the ONE place doc -> buffer mapping happens for the box
 * (`docBoxToBufferBox`), same as a user-dragged box. Computing the seed
 * bbox in buffer space here would double-map it (doc -> buffer at seed
 * time, buffer -> buffer again at request time) — exactly the bug this
 * comment is here to stop reintroducing.
 *
 * `OUTLINE_PROMPT_USES_MASK` (sidecar dogfooding, 2026-09-10): a combined
 * box+coarse-mask prompt localises WORSE than either alone — box-only and
 * mask-only both score IoU > 0.99 against ground truth on the sidecar's own
 * eval, box+mask together do not. The coarse-mask code path stays (below,
 * `resolveOutlineSeed`/`outlineMaskFromDocPaths`) so it can be flipped back
 * on if that finding changes with more real-world prompts, but it is NOT
 * exercised by default: `resolveOutlineSeed` returns box-only
 * (`prompt.mask: false`, `SmartSelectState.outlineMask: null`) while this
 * stays `false`.
 */
export const OUTLINE_PROMPT_USES_MASK = false;

/** The mask-input plane's own size (MobileSAM's decoder convention: 1/4 of its 1024px encoder frame). */
export const OUTLINE_MASK_SIZE = 256;

/** The long side MobileSAM's image encoder resizes its input to before the mask-input plane is derived. */
const SAM_ENCODER_LONG_SIDE = 1024;

/**
 * SAM's own preprocessing frame (sidecar dogfooding, 2026-09-10): the image
 * is resized so its LONGER side becomes `SAM_ENCODER_LONG_SIDE` px, aspect
 * preserved, top-left anchored — padding lands on the bottom/right only,
 * never a per-axis stretch. A single uniform scalar, not independent x/y
 * factors (the bug this replaces: stretching buffer W×H directly onto a
 * 256x256 square distorted non-square images).
 */
export function samEncoderScale(bufferSize: [number, number]): number {
  const longest = Math.max(bufferSize[0], bufferSize[1]);
  return longest === 0 ? 0 : SAM_ENCODER_LONG_SIDE / longest;
}

/**
 * Buffer pixel space -> the 256x256 mask-input plane: SAM's own encoder
 * scale (`samEncoderScale`), then /4 for the mask plane's own downsample
 * from the 1024px encoder frame — top-left anchored throughout, so `(0, 0)`
 * in buffer space is always `(0, 0)` on the mask plane.
 */
export function bufferToMaskPlane(point: Point2D, bufferSize: [number, number]): Point2D {
  const scale = samEncoderScale(bufferSize) / 4;
  return { x: point.x * scale, y: point.y * scale };
}

export interface OutlinePromptDeps {
  /**
   * Rasterise mask-plane-space paths (already mapped through
   * `bufferToMaskPlane`) into a 256x256 u8 coarse mask (0/255) — the one
   * canvas-touching step, injected so this module needs no OffscreenCanvas
   * in tests (mirrors `cook.ts`'s injected `rasterizeVector`).
   */
  rasterize: (paths: VectorPath[], fillRule: 'nonzero' | 'evenodd') => Uint8Array;
}

function realRasterize(paths: VectorPath[], fillRule: 'nonzero' | 'evenodd'): Uint8Array {
  const canvas = new OffscreenCanvas(OUTLINE_MASK_SIZE, OUTLINE_MASK_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  // Paths are already in mask-plane pixel space (bufferToMaskPlane applied
  // by the caller) — identity transform, no further scaling here.
  const path2d = buildPath2D(pathCommandsFor(paths));
  ctx.fillStyle = '#fff';
  ctx.fill(path2d, fillRule);

  const image = ctx.getImageData(0, 0, OUTLINE_MASK_SIZE, OUTLINE_MASK_SIZE);
  const plane = new Uint8Array(OUTLINE_MASK_SIZE * OUTLINE_MASK_SIZE);
  // Threshold to a hard 0/255 coarse mask — a feathered alpha edge from the
  // downsample would read as false graded confidence to the decoder.
  for (let i = 0; i < plane.length; i++) plane[i] = image.data[i * 4 + 3] >= 128 ? 255 : 0;
  return plane;
}

export const productionOutlinePromptDeps: OutlinePromptDeps = { rasterize: realRasterize };

function mapAnchorToMaskPlane(anchor: AnchorPoint, frame: BufferFrame): AnchorPoint {
  const toMaskPlane = (p: Point2D) => bufferToMaskPlane(docToBuffer(p, frame), frame.bufferSize);
  return {
    point: toMaskPlane(anchor.point),
    handleIn: anchor.handleIn ? toMaskPlane(anchor.handleIn) : undefined,
    handleOut: anchor.handleOut ? toMaskPlane(anchor.handleOut) : undefined,
  };
}

/** Document-space `VectorPath[]` -> the outline's bounding box, in DOCUMENT space — `SmartSelectState.box`'s own contract, mapped to buffer space only at request time (`controller.ts`'s `docBoxToBufferBox`). `undefined` for an empty outline. */
export function outlineDocBox(docPaths: VectorPath[]): Box | undefined {
  const points = docPaths.flatMap((p) => p.anchors.map((a) => a.point));
  return boundingBox(points) ?? undefined;
}

/**
 * Document-space `VectorPath[]` -> the 256x256 coarse mask (SAM's own
 * mask-input plane, see `bufferToMaskPlane`). Only called when
 * `OUTLINE_PROMPT_USES_MASK` is flipped on — kept as its own function so
 * flipping the flag doesn't need to touch the rasterisation code.
 */
export function outlineMaskFromDocPaths(
  docPaths: VectorPath[],
  fillRule: 'nonzero' | 'evenodd',
  frame: BufferFrame,
  deps: OutlinePromptDeps = productionOutlinePromptDeps,
): Uint8Array {
  const maskPlanePaths: VectorPath[] = docPaths.map((p) => ({
    closed: p.closed,
    anchors: p.anchors.map((a) => mapAnchorToMaskPlane(a, frame)),
  }));
  return deps.rasterize(maskPlanePaths, fillRule);
}

export interface OutlineSeed {
  /** Document space — feeds `useSmartSelectStore.seedOutline`/`setBox` directly, no mapping here. */
  box: Box;
  /** `null` while `OUTLINE_PROMPT_USES_MASK` is off — box-only by default (sidecar finding above). Mask-plane space when present (SAM's own frame, not document space — it's sent as-is, never round-tripped through `coords.ts`). */
  mask: Uint8Array | null;
}

/**
 * The outline prompt's full seed: a document-space box always, the coarse
 * mask only behind `OUTLINE_PROMPT_USES_MASK` (and only computed — no
 * wasted rasterisation — when the flag is on). The single entry point
 * `Viewport.tsx`'s activation effect calls; `outlineDocBox`/
 * `outlineMaskFromDocPaths` stay exported separately for direct unit
 * testing.
 */
export function resolveOutlineSeed(
  docPaths: VectorPath[],
  fillRule: 'nonzero' | 'evenodd',
  frame: BufferFrame,
  deps: OutlinePromptDeps = productionOutlinePromptDeps,
): OutlineSeed | undefined {
  const box = outlineDocBox(docPaths);
  if (!box) return undefined;
  const mask = OUTLINE_PROMPT_USES_MASK
    ? outlineMaskFromDocPaths(docPaths, fillRule, frame, deps)
    : null;
  return { box, mask };
}
