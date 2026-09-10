import * as cache from '@/scene/cache';
import { useSceneStore } from '@/scene/store';
import { IDENTITY_TRANSFORM_2D, isPixelNode, type SceneNode } from '@/scene/types';
import { type BufferFrame, frameFor } from './coords';

export interface TargetPayload {
  /** RGBA8 bytes, `width * height * 4`. */
  image: Uint8Array;
  width: number;
  height: number;
  /** Maps this payload's document-space geometry (points/box/polygons) to/from its buffer pixel space — `coords.ts`. */
  frame: BufferFrame;
}

/** Edges injected for tests, same pattern as `cook.ts`'s `CookDeps`. */
export interface SelectPayloadDeps {
  getNode: (nodeId: string) => SceneNode | undefined;
  getCachedWorking: (nodeId: string) => ImageBitmap | undefined;
  getDocumentSize: () => [number, number];
  /** ImageBitmap -> RGBA8 bytes, drawn at the bitmap's own size (it's already the cook target — no further downscale) — same OffscreenCanvas readback shape as `cook.ts`'s private `realDownscale`, which isn't exported. */
  readBitmap: (bitmap: ImageBitmap) => Uint8Array;
}

function realReadBitmap(bitmap: ImageBitmap): Uint8Array {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return new Uint8Array(
    imageData.data.buffer,
    imageData.data.byteOffset,
    imageData.data.byteLength,
  );
}

export const productionSelectPayloadDeps: SelectPayloadDeps = {
  getNode: (nodeId) => useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId),
  getCachedWorking: (nodeId) => cache.get(nodeId, 'working'),
  getDocumentSize: () => useSceneStore.getState().scene.documentSize,
  readBitmap: realReadBitmap,
};

type FrameDeps = Pick<SelectPayloadDeps, 'getNode' | 'getCachedWorking' | 'getDocumentSize'>;

/** Shared by `getTargetFrame` and `getTargetPayload` — the bitmap lookup and frame maths neither needs the other to duplicate. */
function resolveTargetFrame(
  nodeId: string,
  deps: FrameDeps,
): { bitmap: ImageBitmap; frame: BufferFrame } | undefined {
  const node = deps.getNode(nodeId);
  if (!node || (node.type !== 'pixel' && node.type !== 'vector')) return undefined;

  const bitmap = deps.getCachedWorking(nodeId);
  if (!bitmap) return undefined;

  const extent = isPixelNode(node) ? node.sourceSize : deps.getDocumentSize();
  const frame = frameFor(
    extent,
    [bitmap.width, bitmap.height],
    node.transform2d ?? IDENTITY_TRANSFORM_2D,
  );
  return { bitmap, frame };
}

/**
 * The target node's document<->buffer mapping frame, without reading any
 * pixel bytes — for callers that only need `frame` (the outline-prompt seed
 * at tool activation), so they don't pay for a `getImageData` readback that
 * `fire()`'s own `getTargetPayload` call repeats 150ms later anyway.
 * `undefined` on the same conditions as `getTargetPayload`.
 */
export function getTargetFrame(
  nodeId: string,
  deps: FrameDeps = productionSelectPayloadDeps,
): BufferFrame | undefined {
  return resolveTargetFrame(nodeId, deps)?.frame;
}

/**
 * The target node's cooked RGBA8 bytes at WORKING resolution, plus the
 * frame needed to map its geometry to/from document space. `undefined` when
 * the node isn't a pixel/vector node, or hasn't cooked a WORKING bitmap yet
 * — the tool has nothing to segment (same "no decoded source" posture
 * `cook.ts` takes for a pixel node with no source; the caller is expected to
 * surface this as a hint, not a crash).
 */
export function getTargetPayload(
  nodeId: string,
  deps: SelectPayloadDeps = productionSelectPayloadDeps,
): TargetPayload | undefined {
  const resolved = resolveTargetFrame(nodeId, deps);
  if (!resolved) return undefined;
  const { bitmap, frame } = resolved;
  return { image: deps.readBitmap(bitmap), width: bitmap.width, height: bitmap.height, frame };
}
