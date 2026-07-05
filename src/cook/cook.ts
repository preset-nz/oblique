import { toast } from 'sonner';
import * as cache from '@/scene/cache';
import { rasterizeMask, rasterizeVectorMask } from '@/scene/maskRasterize';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import {
  IDENTITY_TRANSFORM_2D,
  isVectorNode,
  type MaskDef,
  type Modifier,
  type PixelNode,
  type SceneNode,
  type Transform2D,
  type VectorMaskRef,
  type VectorNode,
} from '@/scene/types';
import { rasterizeVector } from '@/scene/vectorRasterize';
import { type OpDescriptor, useOpsCacheStore } from '@/sidecar/opsCache';

/** Cook targets DRAFT (1/8) and WORKING (1/2); BAKED is Epic 07's job. */
export type CookLevel = 'draft' | 'working';

const RESOLUTION_FACTOR: Record<CookLevel, number> = {
  draft: 1 / 8,
  working: 1 / 2,
};

/** Downscale factor for a cook level. Exported for the scheduler/tests. */
export function resolutionFactor(level: CookLevel): number {
  return RESOLUTION_FACTOR[level];
}

/** Source size x factor, rounded, minimum 1px per side. */
export function computeTargetSize(sourceSize: [number, number], factor: number): [number, number] {
  const w = Math.max(1, Math.round(sourceSize[0] * factor));
  const h = Math.max(1, Math.round(sourceSize[1] * factor));
  return [w, h];
}

export interface CookModifier {
  type: string;
  backend: 'python' | 'rust';
  params: Modifier['params'];
  /** Rasterised mask plane (1 byte/px, cook target size) when the modifier carries a maskId — attached by `cookNode`, consumed by the frame packing (selection-to-mask.md). */
  mask?: Uint8Array;
}

/**
 * Enabled modifiers only, in stack order, with `spatial`-scaled params
 * multiplied by `factor` (spec per starter-ops.md — params are authored in
 * document space, the client scales before the request). A modifier whose
 * op isn't in the cached registry yet (sidecar hasn't answered `list_ops`,
 * or the op is unknown) is passed through unscaled — the sidecar's own
 * validation is the backstop, this is just the best-effort client scale.
 */
export function buildCookModifiers(
  modifiers: Modifier[],
  factor: number,
  ops: OpDescriptor[],
  /** Rasterises a modifier's mask at the cook target size — injected so this stays pure/testable; absent = masks ignored (export paths pass it, tests may not). */
  rasterizeFor?: (maskId: string) => Uint8Array | undefined,
): CookModifier[] {
  const opByName = new Map(ops.map((o) => [o.name, o]));
  return modifiers
    .filter((m) => m.enabled)
    .map((m) => {
      const mask = m.maskId && rasterizeFor ? rasterizeFor(m.maskId) : undefined;
      const descriptor = opByName.get(m.type);
      const backend = descriptor?.backend ?? 'python';
      if (!descriptor) return { type: m.type, backend, params: m.params, mask };

      const paramSpecByName = new Map(descriptor.params.map((p) => [p.name, p]));
      const params: Modifier['params'] = {};
      for (const [key, value] of Object.entries(m.params)) {
        const spec = paramSpecByName.get(key);
        params[key] =
          spec?.scale === 'spatial' && typeof value === 'number' ? value * factor : value;
      }
      return { type: m.type, backend, params, mask };
    });
}

export interface MaskHeaderEntry {
  /** Index into THIS request's `modifiers` array (per run, not per stack). */
  modifierIndex: number;
  mask_bytes: number;
}

/**
 * Frame-format extension (selection-to-mask.md §What this costs): mask
 * planes append after the image payload in modifier order; the header's
 * `masks` array carries per-mask lengths so the sidecar can slice them back
 * out. With zero masked modifiers this returns the image untouched and no
 * `masks` array — the request stays byte-identical to the pre-mask format
 * (story acceptance; pinned by cook.test.ts).
 */
export function packMaskedPayload(
  image: Uint8Array,
  modifiers: CookModifier[],
): { masks?: MaskHeaderEntry[]; payload: Uint8Array } {
  const entries: MaskHeaderEntry[] = [];
  const planes: Uint8Array[] = [];
  modifiers.forEach((m, i) => {
    if (m.mask) {
      entries.push({ modifierIndex: i, mask_bytes: m.mask.byteLength });
      planes.push(m.mask);
    }
  });
  if (entries.length === 0) return { payload: image };

  const total = image.byteLength + planes.reduce((n, p) => n + p.byteLength, 0);
  const payload = new Uint8Array(total);
  payload.set(image, 0);
  let offset = image.byteLength;
  for (const plane of planes) {
    payload.set(plane, offset);
    offset += plane.byteLength;
  }
  return { masks: entries, payload };
}

export interface CookRun {
  backend: 'python' | 'rust';
  modifiers: CookModifier[];
}

/** Partition into maximal runs of consecutive same-backend modifiers (architecture §Op backends). */
export function partitionRuns(modifiers: CookModifier[]): CookRun[] {
  const runs: CookRun[] = [];
  for (const modifier of modifiers) {
    const last = runs[runs.length - 1];
    if (last && last.backend === modifier.backend) {
      last.modifiers.push(modifier);
    } else {
      runs.push({ backend: modifier.backend, modifiers: [modifier] });
    }
  }
  return runs;
}

/**
 * One toast per error burst, not per retry — reset when the sidecar comes
 * back up (the scheduler calls `resetCookErrorBurst` on that transition).
 */
let errorBurstActive = false;

export function resetCookErrorBurst(): void {
  errorBurstActive = false;
}

function reportCookFailure(message: string): void {
  if (errorBurstActive) return;
  errorBurstActive = true;
  toast.error('Cook failed', { description: message });
}

/**
 * Real browser/Tauri wiring, injected as `CookDeps` so the executor's
 * control-flow (scaling, run-partitioning, the conditional clearDirty) is
 * testable without OffscreenCanvas/createImageBitmap — same pattern as
 * `project/import.ts`'s `ImportDeps`.
 */
export interface CookDeps {
  getNode: (nodeId: string) => SceneNode | undefined;
  getSource: (nodeId: string) => ImageBitmap | undefined;
  /** `Scene.documentSize` — a vector node's raster spans this (vector-node-model.md's Sizing note), it has no `sourceSize` of its own. */
  getDocumentSize: () => [number, number];
  getOps: () => OpDescriptor[];
  getMask: (maskId: string) => MaskDef | undefined;
  /** `Modifier.maskId`'s second resolution target (vector-modifier-masks.md) — a live vector reference, resolved after `getMask` comes up empty. */
  getVectorMaskRef: (maskId: string) => VectorMaskRef | undefined;
  /** Rasterise a mask to a single-channel plane at the cook target size (scene/maskRasterize.ts; needs OffscreenCanvas, so injected). */
  rasterizeMask: (
    mask: MaskDef,
    sourceSize: [number, number],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  /** Rasterise a live vector-referenced mask (scene/maskRasterize.ts's `rasterizeVectorMask`; needs OffscreenCanvas, so injected, same pattern as `rasterizeMask`). */
  rasterizeVectorMask: (
    paths: VectorNode['paths'],
    fillRule: VectorNode['fillRule'],
    ref: Pick<VectorMaskRef, 'featherPx' | 'expand' | 'invert'>,
    consumerTransform2d: Transform2D,
    consumerSourceSize: [number, number],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  /** Draw `source` into an offscreen surface at `[w, h]` and read back RGBA8 bytes. */
  downscale: (source: ImageBitmap, width: number, height: number) => Uint8Array;
  /** Rasterise a vector node's paths at the cook target size — a vector node's "source pixels" (scene/vectorRasterize.ts; needs OffscreenCanvas, so injected, same pattern as `rasterizeMask`). */
  rasterizeVector: (
    paths: VectorNode['paths'],
    fillRule: VectorNode['fillRule'],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  /** One sidecar `cook` call for a same-backend run. */
  runPython: (
    width: number,
    height: number,
    modifiers: CookModifier[],
    payload: Uint8Array,
  ) => Promise<Uint8Array>;
  /** RGBA8 bytes -> displayable bitmap. */
  encode: (bytes: Uint8Array, width: number, height: number) => Promise<ImageBitmap>;
  setCache: (nodeId: string, level: CookLevel, bitmap: ImageBitmap) => void;
  clearDirty: (nodeId: string, level: CookLevel) => void;
}

function realDownscale(source: ImageBitmap, width: number, height: number): Uint8Array {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(source, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(
    imageData.data.buffer,
    imageData.data.byteOffset,
    imageData.data.byteLength,
  );
}

async function realEncode(bytes: Uint8Array, width: number, height: number): Promise<ImageBitmap> {
  const imageData = new ImageData(new Uint8ClampedArray(bytes), width, height);
  return createImageBitmap(imageData);
}

async function realRunPython(
  width: number,
  height: number,
  modifiers: CookModifier[],
  payload: Uint8Array,
): Promise<Uint8Array> {
  // Dynamic import: the singleton starts the real Tauri transport as a
  // side effect of being imported (see sidecar/singleton.ts). Deferring the
  // import to call-time keeps that side effect out of every test that
  // imports this module with injected `CookDeps` (which never reaches
  // this function) — only a real production cook pulls it in.
  const { sidecarClient } = await import('@/sidecar/singleton');
  const packed = packMaskedPayload(payload, modifiers);
  const { header, payload: result } = await sidecarClient.request(
    {
      op: 'cook',
      width,
      height,
      modifiers: modifiers.map((m) => ({ type: m.type, params: m.params })),
      // Spread-omitted when no modifier is masked — keeps the zero-mask
      // request byte-identical to the pre-mask frame format (story
      // acceptance).
      ...(packed.masks ? { masks: packed.masks } : {}),
    },
    packed.payload,
  );
  if (Array.isArray(header.timings_ms)) {
    const perOp = (header.timings_ms as { type: string; ms: number }[])
      .map((t) => `${t.type} ${t.ms}ms`)
      .join(', ');
    console.debug(`[cook] sidecar ops ${width}x${height}: ${perOp}`);
  }
  return result;
}

/**
 * `Modifier.maskId` resolution rule (vector-modifier-masks.md, the epic's
 * data-model decision): try `Scene.masks` first (a baked `MaskDef`), then
 * `Scene.maskRefs` (a live vector reference) — the two id spaces are
 * disjoint by construction (`store.ts`'s `setModifierMask`/
 * `setModifierVectorMask` each clear the other table's entry under the same
 * id), so "try masks, else maskRefs" never has to break a tie. A maskRefs
 * hit whose target node has since gone missing or isn't a vector any more
 * (shouldn't happen post-`pruneMaskState`, but this is the last line of
 * defence) resolves to "no mask" rather than throwing — same posture as an
 * unresolved id today.
 */
function makeRasterizeFor(
  deps: Pick<
    CookDeps,
    'getNode' | 'getMask' | 'getVectorMaskRef' | 'rasterizeMask' | 'rasterizeVectorMask'
  >,
  nodeExtent: [number, number],
  consumerTransform2d: Transform2D,
  width: number,
  height: number,
  factor: number,
): (maskId: string) => Uint8Array | undefined {
  return (maskId: string) => {
    const mask = deps.getMask(maskId);
    if (mask) return deps.rasterizeMask(mask, nodeExtent, width, height, factor);

    const ref = deps.getVectorMaskRef(maskId);
    if (!ref) return undefined;
    const vectorNode = deps.getNode(ref.nodeId);
    if (!vectorNode || !isVectorNode(vectorNode)) return undefined;
    return deps.rasterizeVectorMask(
      vectorNode.paths,
      vectorNode.fillRule,
      ref,
      consumerTransform2d,
      nodeExtent,
      width,
      height,
      factor,
    );
  };
}

/** Production deps: real store/cache/sources/canvas/sidecar wiring. */
export const productionCookDeps: CookDeps = {
  getNode: (nodeId) => useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId),
  getSource: (nodeId) => sources.get(nodeId),
  getDocumentSize: () => useSceneStore.getState().scene.documentSize,
  getOps: () => useOpsCacheStore.getState().ops,
  getMask: (maskId) => useSceneStore.getState().scene.masks?.[maskId],
  getVectorMaskRef: (maskId) => useSceneStore.getState().scene.maskRefs?.[maskId],
  rasterizeMask,
  rasterizeVectorMask,
  downscale: realDownscale,
  rasterizeVector,
  runPython: realRunPython,
  encode: realEncode,
  setCache: cache.set,
  clearDirty: (nodeId, level) => useSceneStore.getState().clearDirty(nodeId, level),
};

/**
 * Subset of `CookDeps` needed by a one-shot full-resolution cook: no cache
 * writes, no dirty tracking (export.ts, not the scheduler).
 */
export interface FullResCookDeps {
  getNode: (nodeId: string) => SceneNode | undefined;
  getSource: (nodeId: string) => ImageBitmap | undefined;
  getOps: () => OpDescriptor[];
  getMask: (maskId: string) => MaskDef | undefined;
  getVectorMaskRef: (maskId: string) => VectorMaskRef | undefined;
  rasterizeMask: (
    mask: MaskDef,
    sourceSize: [number, number],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  rasterizeVectorMask: (
    paths: VectorNode['paths'],
    fillRule: VectorNode['fillRule'],
    ref: Pick<VectorMaskRef, 'featherPx' | 'expand' | 'invert'>,
    consumerTransform2d: Transform2D,
    consumerSourceSize: [number, number],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  downscale: (source: ImageBitmap, width: number, height: number) => Uint8Array;
  runPython: (
    width: number,
    height: number,
    modifiers: CookModifier[],
    payload: Uint8Array,
  ) => Promise<Uint8Array>;
  encode: (bytes: Uint8Array, width: number, height: number) => Promise<ImageBitmap>;
}

/** Production full-res deps: same real wiring as `productionCookDeps`, minus cache/dirty. */
export const productionFullResCookDeps: FullResCookDeps = {
  getNode: productionCookDeps.getNode,
  getSource: productionCookDeps.getSource,
  getOps: productionCookDeps.getOps,
  getMask: productionCookDeps.getMask,
  getVectorMaskRef: productionCookDeps.getVectorMaskRef,
  rasterizeMask: productionCookDeps.rasterizeMask,
  rasterizeVectorMask: productionCookDeps.rasterizeVectorMask,
  downscale: realDownscale,
  runPython: realRunPython,
  encode: realEncode,
};

/**
 * One-shot full-resolution cook for export (architecture.md's "baked"
 * factor, 1 — the node's own `sourceSize`, no downscale). Never writes any
 * cache slot and never clears/sets dirty — that's the scheduler's job, not
 * export's (locking semantics for a real persisted baked cache are Epic
 * 07's). Throws on any failure (missing/non-pixel node, no decoded source,
 * sidecar error) rather than falling back to a lower-resolution bitmap —
 * export.ts must abort the whole export on this, never substitute a draft
 * upscale (epic acceptance).
 */
export async function cookNodeFullRes(
  nodeId: string,
  deps: FullResCookDeps = productionFullResCookDeps,
): Promise<ImageBitmap> {
  const rawNode = deps.getNode(nodeId);
  if (rawNode?.type !== 'pixel') {
    throw new Error(`node ${nodeId} is not a pixel node`);
  }
  const node = rawNode as PixelNode;

  const source = deps.getSource(nodeId);
  if (!source) {
    throw new Error(`"${node.label}" has no decoded source loaded`);
  }

  const factor = 1; // full resolution — node's own sourceSize, no downscale
  const [width, height] = computeTargetSize(node.sourceSize, factor);

  let resultBytes = deps.downscale(source, width, height);
  const rasterizeFor = makeRasterizeFor(
    deps,
    node.sourceSize,
    node.transform2d ?? IDENTITY_TRANSFORM_2D,
    width,
    height,
    factor,
  );
  const cookModifiers = buildCookModifiers(node.modifiers, factor, deps.getOps(), rasterizeFor);

  if (cookModifiers.length > 0) {
    const runs = partitionRuns(cookModifiers);
    for (const run of runs) {
      if (run.backend === 'rust') {
        // deferred: rust ops via `cook_rust` — no rust ops exist yet.
        throw new Error('rust op backend not yet implemented');
      }
      resultBytes = await deps.runPython(width, height, run.modifiers, resultBytes);
    }
  }

  return deps.encode(resultBytes, width, height);
}

/**
 * Cook one node at one resolution level: downscale the source, run the
 * enabled modifier stack through the sidecar (partitioned by backend —
 * today that's always a single Python run, per starter-ops.md), write the
 * result to the cache, and clear dirty.
 *
 * If the node was mutated again after this cook started (its `modifiers`
 * array reference changed), the freshly-cooked bitmap is still written
 * (newer than nothing) but dirty is left set — the scheduler's own
 * store subscription re-armed the debounce for that later mutation, so a
 * follow-up cook with the latest params is already on the way. Clearing
 * dirty unconditionally here would race that follow-up cook out of
 * existence (see cook-pipeline.md's scheduler note).
 *
 * Failure (sidecar down, op error): dirty stays set, the stale cache is
 * left alone, one toast per error burst (see `reportCookFailure`); the
 * scheduler retries automatically on the next `sidecar-status: up`.
 */
export async function cookNode(
  nodeId: string,
  level: CookLevel,
  deps: CookDeps = productionCookDeps,
): Promise<void> {
  const rawNode = deps.getNode(nodeId);
  if (rawNode?.type !== 'pixel' && rawNode?.type !== 'vector') return;
  // PixelNode/VectorNode are the two source-pixel-producing node types
  // today; the cast is safe once `type` is checked (mirrors the pattern in
  // project/import.ts).
  const node = rawNode as PixelNode | VectorNode;

  const factor = resolutionFactor(level);
  // A vector node has no `sourceSize` of its own — its raster always spans
  // `Scene.documentSize` (vector-node-model.md's Sizing note).
  const nodeExtent = node.type === 'pixel' ? node.sourceSize : deps.getDocumentSize();
  const [width, height] = computeTargetSize(nodeExtent, factor);

  // A missing pixel source is not a cook failure (no toast, dirty stays
  // set, paintScene shows the striped placeholder) — checked before the
  // try block below, which is reserved for actual op/sidecar failures.
  // Vector nodes have no equivalent "missing" state: rasterizeVector always
  // has something to draw (an empty paths array rasterises to nothing).
  const source = node.type === 'pixel' ? deps.getSource(nodeId) : undefined;
  if (node.type === 'pixel' && !source) return;

  const modifiersAtStart = node.modifiers;

  // Phase timings, logged at debug level. performance.now() reads are
  // sub-microsecond against phases costing milliseconds — measuring here
  // cannot skew the result. console.debug is invisible (and near-free)
  // unless devtools' Verbose level is on.
  const t0 = performance.now();
  try {
    let resultBytes =
      node.type === 'pixel'
        ? deps.downscale(source as ImageBitmap, width, height)
        : deps.rasterizeVector(node.paths, node.fillRule, width, height, factor);
    const tDownscale = performance.now();
    const rasterizeFor = makeRasterizeFor(
      deps,
      nodeExtent,
      node.transform2d ?? IDENTITY_TRANSFORM_2D,
      width,
      height,
      factor,
    );
    const cookModifiers = buildCookModifiers(modifiersAtStart, factor, deps.getOps(), rasterizeFor);

    if (cookModifiers.length > 0) {
      const runs = partitionRuns(cookModifiers);
      for (const run of runs) {
        if (run.backend === 'rust') {
          // deferred: rust ops via `cook_rust` (lands with the first Rust op) —
          // no rust ops exist yet, so this branch is currently unreachable.
          throw new Error('rust op backend not yet implemented');
        }
        resultBytes = await deps.runPython(width, height, run.modifiers, resultBytes);
      }
    }
    const tSidecar = performance.now();

    const bitmap = await deps.encode(resultBytes, width, height);
    const tEncode = performance.now();
    console.debug(
      `[cook] ${node.label} ${level} ${width}x${height}: total ${(tEncode - t0).toFixed(1)}ms ` +
        `(downscale ${(tDownscale - t0).toFixed(1)}, sidecar+ipc ${(tSidecar - tDownscale).toFixed(1)}, ` +
        `encode ${(tEncode - tSidecar).toFixed(1)})`,
    );
    deps.setCache(nodeId, level, bitmap);

    const current = deps.getNode(nodeId);
    if (current && current.modifiers === modifiersAtStart) {
      deps.clearDirty(nodeId, level);
    }
    // Note: the error-burst flag is NOT reset on a bare success here — a
    // zero-modifier node can cook successfully (no sidecar call at all)
    // while the sidecar is down and other nodes are failing. Only the
    // scheduler's explicit sidecar-status: up transition ends a burst.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportCookFailure(message);
    // Dirty stays set, stale cache untouched — the scheduler retries on
    // the next sidecar-status: up.
  }
}
