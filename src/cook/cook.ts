import { notify } from '@preset.nz/ux-kit';
import { useLastCookStore } from '@/cook/lastCook';
import * as prefixCache from '@/cook/prefixCache';
import { fontCatalogueSettled } from '@/fonts/catalogue';
import type { TextGeometry } from '@/fonts/textGeometry';
import * as cache from '@/scene/cache';
import { histogramKey, storeResponseHistograms } from '@/scene/histograms';
import {
  type DriverRasterKey,
  hasDocumentPinnedMask,
  pixelDriversOf,
  resolvedDriverInput,
  resolvedMaskInput,
} from '@/scene/maskInputs';
import { rasterizePixelMask, rasterizeVectorMask } from '@/scene/maskRasterize';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import { documentPathsFor, ensureGeometry, textCookKey } from '@/scene/textGeometryCache';
import { rasterizeText } from '@/scene/textRasterize';
import {
  IDENTITY_TRANSFORM_2D,
  isPixelMaskRef,
  isPixelNode,
  isTextNode,
  isVectorNode,
  type MaskRef,
  type Modifier,
  type ModifierDriver,
  type PixelNode,
  type SceneNode,
  type TextNode,
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
  /**
   * The plane of the layer driving one of the op's values (Epic 27, blur-radius.md): one byte per
   * pixel at the cook target size, white meaning the full effect, as a mask plane is. Only on a
   * modifier whose op offers `kind`: the sidecar refuses the whole cook otherwise.
   */
  driver?: { kind: string; plane: Uint8Array };
  /**
   * The key (`histogramKey`: layer and modifier id) of a scene modifier whose op draws a histogram
   * of its input (levels): the request asks the sidecar for the bins of the picture reaching this
   * one, and the response files them under this key (`scene/histograms.ts`). Set by the draft cook only; absent everywhere else,
   * and then the request and response are the frames they always were.
   */
  histogramFor?: string;
}

/**
 * `cookModifiers` (built from `pending`, 1:1) of layer `nodeId` with `histogramFor` set on each
 * whose op asks for a histogram. A new array; the inputs are left as they were.
 */
export function withHistograms(
  nodeId: string,
  cookModifiers: CookModifier[],
  pending: Modifier[],
  ops: OpDescriptor[],
): CookModifier[] {
  const asking = new Set(ops.filter((o) => o.histogram).map((o) => o.name));
  return cookModifiers.map((m, i) => {
    const source = pending[i];
    return source && asking.has(m.type)
      ? { ...m, histogramFor: histogramKey(nodeId, source.id) }
      : m;
  });
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
  /** Rasterises a modifier's driver (Epic 27) at the cook target size; absent = drivers ignored. */
  rasterizeDriver?: (driver: ModifierDriver) => Uint8Array | undefined,
): CookModifier[] {
  const opByName = new Map(ops.map((o) => [o.name, o]));
  return modifiers
    .filter((m) => m.enabled)
    .map((m) => {
      const mask = m.maskId && rasterizeFor ? rasterizeFor(m.maskId) : undefined;
      const descriptor = opByName.get(m.type);
      const backend = descriptor?.backend ?? 'python';
      if (!descriptor) return { type: m.type, backend, params: m.params, mask };
      // a driver the op doesn't offer (an older sidecar, a file from elsewhere) cooks undriven
      const plane =
        m.driver && rasterizeDriver && descriptor.drivers?.some((d) => d.kind === m.driver?.kind)
          ? rasterizeDriver(m.driver)
          : undefined;
      const driver = m.driver && plane ? { kind: m.driver.kind, plane } : undefined;

      const paramSpecByName = new Map(descriptor.params.map((p) => [p.name, p]));
      const params: Modifier['params'] = {};
      for (const [key, value] of Object.entries(m.params)) {
        const spec = paramSpecByName.get(key);
        params[key] =
          spec?.scale === 'spatial' && typeof value === 'number' ? value * factor : value;
      }
      return { type: m.type, backend, params, mask, ...(driver ? { driver } : {}) };
    });
}

export interface DriverHeaderEntry {
  /** Index into THIS request's `modifiers` array. */
  modifierIndex: number;
  /** Which of the op's drivers the plane is (`radius`). */
  kind: string;
  driver_bytes: number;
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
): { masks?: MaskHeaderEntry[]; drivers?: DriverHeaderEntry[]; payload: Uint8Array } {
  const entries: MaskHeaderEntry[] = [];
  const driverEntries: DriverHeaderEntry[] = [];
  const planes: Uint8Array[] = [];
  modifiers.forEach((m, i) => {
    if (m.mask) {
      entries.push({ modifierIndex: i, mask_bytes: m.mask.byteLength });
      planes.push(m.mask);
    }
  });
  // driver planes (Epic 27) follow every mask plane, in modifier order
  modifiers.forEach((m, i) => {
    if (m.driver) {
      driverEntries.push({
        modifierIndex: i,
        kind: m.driver.kind,
        driver_bytes: m.driver.plane.byteLength,
      });
      planes.push(m.driver.plane);
    }
  });
  if (entries.length === 0 && driverEntries.length === 0) return { payload: image };

  const total = image.byteLength + planes.reduce((n, p) => n + p.byteLength, 0);
  const payload = new Uint8Array(total);
  payload.set(image, 0);
  let offset = image.byteLength;
  for (const plane of planes) {
    payload.set(plane, offset);
    offset += plane.byteLength;
  }
  return {
    ...(entries.length > 0 ? { masks: entries } : {}),
    ...(driverEntries.length > 0 ? { drivers: driverEntries } : {}),
    payload,
  };
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
  notify({ message: 'Cook failed', kind: 'error', description: message });
}

/** A driver layer's cooked raster as a consumer's cook reads it, and which write it was. */
export interface DriverRaster {
  bitmap: ImageBitmap;
  /** `<cache level>:<write sequence>` — changes whenever the driver recooks. */
  key: string;
}

const OTHER_LEVEL: Record<CookLevel, CookLevel> = { draft: 'working', working: 'draft' };

/**
 * The cache map's raster for a driver, for a consumer cooking at `level`: that level, else the
 * bake (a locked driver), else the other level. The scheduler cooks a driver before its
 * consumer, so the first is the usual case; the others only cover a driver that can't cook.
 */
function cachedDriverRaster(nodeId: string, level: CookLevel): DriverRaster | undefined {
  for (const l of [level, 'baked', OTHER_LEVEL[level]] as const) {
    const bitmap = cache.get(nodeId, l);
    if (bitmap) return { bitmap, key: `${l}:${cache.getSeq(nodeId, l)}` };
  }
  return undefined;
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
  /** `Modifier.maskId` resolves against this — a live vector, text or pixel-driver reference. */
  getMaskRef: (maskId: string) => MaskRef | undefined;
  /** Rasterise a live vector-referenced mask (scene/maskRasterize.ts's `rasterizeVectorMask`; needs OffscreenCanvas, so injected). */
  rasterizeVectorMask: (
    paths: VectorNode['paths'],
    fillRule: VectorNode['fillRule'],
    ref: Pick<VectorMaskRef, 'featherPx' | 'expand' | 'invert' | 'space' | 'attachTransform'>,
    vectorTransform2d: Transform2D,
    documentSize: [number, number],
    consumerTransform2d: Transform2D,
    consumerSourceSize: [number, number],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  /**
   * A pixel driver's cooked raster for a cook at `level` (layer-as-driver.md), with the
   * identity the race guard and prefix descriptors fold in. Production reads the cache map:
   * the same level, else the bake, else the other level.
   */
  getDriverRaster: (nodeId: string, level: CookLevel) => DriverRaster | undefined;
  /** Rasterise a pixel-driven mask (scene/maskRasterize.ts's `rasterizePixelMask`; needs OffscreenCanvas, so injected). */
  rasterizePixelMask: typeof rasterizePixelMask;
  /** Draw `source` into an offscreen surface at `[w, h]` and read back RGBA8 bytes. */
  downscale: (source: ImageBitmap, width: number, height: number) => Uint8Array;
  /** Rasterise a vector node's paths at the cook target size — a vector node's "source pixels" (scene/vectorRasterize.ts; needs OffscreenCanvas, so injected). */
  rasterizeVector: (
    paths: VectorNode['paths'],
    fillRule: VectorNode['fillRule'],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  /** Shaped glyph geometry for a text node (scene/textGeometryCache.ts's `ensureGeometry`; hits Rust on a miss, so injected). */
  getTextGeometry: (node: TextNode) => Promise<TextGeometry>;
  /** Rasterise a text node's geometry at the cook target size — a text node's "source pixels" (scene/textRasterize.ts; needs OffscreenCanvas, so injected). */
  rasterizeText: typeof rasterizeText;
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
  /** Prefix cache (prefix-cache.md): the stored intermediate for a node/level. Production wiring is `scene/prefixStore.ts`. */
  getPrefix: (nodeId: string, level: CookLevel) => prefixCache.PrefixEntry | undefined;
  setPrefix: (nodeId: string, level: CookLevel, entry: prefixCache.PrefixEntry) => void;
  /** Descriptors of the last successfully cooked full stack (no bytes) — only used to infer where an edit is happening. */
  getLastStack: (nodeId: string, level: CookLevel) => string[] | undefined;
  setLastStack: (nodeId: string, level: CookLevel, descriptors: string[]) => void;
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
  const histogramIndexes = modifiers.flatMap((m, i) => (m.histogramFor ? [i] : []));
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
      ...(packed.drivers ? { drivers: packed.drivers } : {}),
      // Likewise only when a modifier in this run wants its input's histogram (draft cook).
      ...(histogramIndexes.length > 0 ? { histograms: histogramIndexes } : {}),
    },
    packed.payload,
  );
  storeResponseHistograms(header.histograms, modifiers);
  if (Array.isArray(header.timings_ms)) {
    const perOp = (header.timings_ms as { type: string; ms: number }[])
      .map((t) => `${t.type} ${t.ms}ms`)
      .join(', ');
    console.debug(`[cook] sidecar ops ${width}x${height}: ${perOp}`);
  }
  return result;
}

/**
 * Text-mask geometry prefetch (text-modifier-masks.md). `makeRasterizeFor` is
 * synchronous (it runs inside `buildCookModifiers`) but a text node's glyph
 * geometry is async (Rust on a cache miss), so every text mask target is
 * resolved up front. Keyed by the TARGET text node's id. A ref that doesn't
 * resolve, or whose target isn't a text node, contributes nothing — the same
 * "no mask" posture as `makeRasterizeFor`. Callers sit this inside their
 * failure `try`: a rejection here is a cook failure like any other.
 */
async function prefetchMaskTextGeometry(
  node: SceneNode,
  deps: Pick<CookDeps, 'getNode' | 'getMaskRef' | 'getTextGeometry'>,
): Promise<Map<string, TextGeometry>> {
  const out = new Map<string, TextGeometry>();
  for (const modifier of node.modifiers) {
    if (!modifier.maskId) continue;
    const ref = deps.getMaskRef(modifier.maskId);
    if (!ref || isPixelMaskRef(ref) || out.has(ref.nodeId)) continue;
    const target = deps.getNode(ref.nodeId);
    if (!target || !isTextNode(target)) continue;
    out.set(target.id, await deps.getTextGeometry(target));
  }
  return out;
}

/**
 * `Modifier.maskId` resolution (vector-modifier-masks.md,
 * text-modifier-masks.md): resolves against `Scene.maskRefs` (a live vector or
 * text reference). A hit whose target node has since gone missing or is
 * neither a vector nor a text node (shouldn't happen post-`pruneMaskState`, but
 * this is the last line of defence) resolves to "no mask" rather than
 * throwing — same posture as an unresolved id today. A text target is filled
 * from its prefetched glyph geometry, `nonzero`, translated into document
 * space; fill/stroke colour don't matter (glyph fill only).
 */
function makeRasterizeFor(
  deps: Pick<
    CookDeps,
    'getNode' | 'getMaskRef' | 'getDocumentSize' | 'rasterizeVectorMask' | 'rasterizePixelMask'
  >,
  textGeometry: Map<string, TextGeometry>,
  driverRaster: (driverId: string) => ImageBitmap | undefined,
  nodeExtent: [number, number],
  consumerTransform2d: Transform2D,
  width: number,
  height: number,
  factor: number,
): (maskId: string) => Uint8Array | undefined {
  return (maskId: string) => {
    const ref = deps.getMaskRef(maskId);
    if (!ref) return undefined;
    const target = deps.getNode(ref.nodeId);
    if (!target) return undefined;
    if (isPixelMaskRef(ref)) {
      // A pixel driver (layer-as-driver.md): its cooked raster, sampled in document space.
      // No raster yet reads as transparent, like the page outside the driver.
      if (!isPixelNode(target)) return undefined;
      return deps.rasterizePixelMask(
        driverRaster(target.id),
        ref,
        target.transform2d ?? IDENTITY_TRANSFORM_2D,
        target.sourceSize,
        consumerTransform2d,
        nodeExtent,
        width,
        height,
        factor,
      );
    }
    if (isVectorNode(target)) {
      return deps.rasterizeVectorMask(
        target.paths,
        target.fillRule,
        ref,
        target.transform2d ?? IDENTITY_TRANSFORM_2D,
        deps.getDocumentSize(),
        consumerTransform2d,
        nodeExtent,
        width,
        height,
        factor,
      );
    }
    if (isTextNode(target)) {
      const geometry = textGeometry.get(target.id);
      if (!geometry) return undefined;
      return deps.rasterizeVectorMask(
        documentPathsFor(target, geometry),
        'nonzero',
        ref,
        target.transform2d ?? IDENTITY_TRANSFORM_2D,
        deps.getDocumentSize(),
        consumerTransform2d,
        nodeExtent,
        width,
        height,
        factor,
      );
    }
    return undefined;
  };
}

/**
 * A modifier's driver as a plane at the cook target size (Epic 27): the same reading of the
 * driver layer's raster as a pixel mask's (`rasterizePixelMask`), through the same document
 * space. A driver whose layer is gone or isn't a pixel layer is left out, so the op cooks
 * undriven rather than throwing, as `makeRasterizeFor` does for a mask.
 */
function makeRasterizeDriverFor(
  deps: Pick<CookDeps, 'getNode' | 'rasterizePixelMask'>,
  driverRaster: (driverId: string) => ImageBitmap | undefined,
  nodeExtent: [number, number],
  consumerTransform2d: Transform2D,
  width: number,
  height: number,
  factor: number,
): (driver: ModifierDriver) => Uint8Array | undefined {
  return (driver) => {
    const target = deps.getNode(driver.nodeId);
    if (!target || !isPixelNode(target)) return undefined;
    return deps.rasterizePixelMask(
      driverRaster(target.id),
      driver,
      target.transform2d ?? IDENTITY_TRANSFORM_2D,
      target.sourceSize,
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
  getMaskRef: (maskId) => useSceneStore.getState().scene.maskRefs?.[maskId],
  rasterizeVectorMask,
  getDriverRaster: cachedDriverRaster,
  rasterizePixelMask,
  downscale: realDownscale,
  rasterizeVector,
  // Wait for the font catalogue first: until it settles, effectiveFontFor
  // can't substitute a missing font (missing-fonts.md), and a restored
  // document would toast a cook failure on every relaunch.
  getTextGeometry: async (node) => {
    await fontCatalogueSettled();
    return ensureGeometry(node);
  },
  rasterizeText,
  runPython: realRunPython,
  encode: realEncode,
  setCache: cache.set,
  clearDirty: (nodeId, level) => useSceneStore.getState().clearDirty(nodeId, level),
  getPrefix: prefixCache.getPrefix,
  setPrefix: prefixCache.setPrefix,
  getLastStack: prefixCache.getLastStack,
  setLastStack: prefixCache.setLastStack,
};

/**
 * Subset of `CookDeps` needed by a one-shot full-resolution cook: no cache
 * writes, no dirty tracking (export.ts, not the scheduler).
 */
export interface FullResCookDeps {
  getNode: (nodeId: string) => SceneNode | undefined;
  getSource: (nodeId: string) => ImageBitmap | undefined;
  getOps: () => OpDescriptor[];
  getDocumentSize: () => [number, number];
  getMaskRef: (maskId: string) => MaskRef | undefined;
  rasterizeVectorMask: (
    paths: VectorNode['paths'],
    fillRule: VectorNode['fillRule'],
    ref: Pick<VectorMaskRef, 'featherPx' | 'expand' | 'invert' | 'space' | 'attachTransform'>,
    vectorTransform2d: Transform2D,
    documentSize: [number, number],
    consumerTransform2d: Transform2D,
    consumerSourceSize: [number, number],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  /** Same injection as `CookDeps.rasterizePixelMask`; the driver's raster is its own full-res cook. */
  rasterizePixelMask: typeof rasterizePixelMask;
  downscale: (source: ImageBitmap, width: number, height: number) => Uint8Array;
  /** A vector node's "source pixels" at full res — same injection as `CookDeps.rasterizeVector`. */
  rasterizeVector: (
    paths: VectorNode['paths'],
    fillRule: VectorNode['fillRule'],
    width: number,
    height: number,
    factor: number,
  ) => Uint8Array;
  /** A text node's glyph geometry — same injection as `CookDeps.getTextGeometry`. */
  getTextGeometry: (node: TextNode) => Promise<TextGeometry>;
  /** A text node's "source pixels" at full res — same injection as `CookDeps.rasterizeText`. */
  rasterizeText: typeof rasterizeText;
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
  getDocumentSize: productionCookDeps.getDocumentSize,
  getMaskRef: productionCookDeps.getMaskRef,
  rasterizeVectorMask: productionCookDeps.rasterizeVectorMask,
  rasterizePixelMask: productionCookDeps.rasterizePixelMask,
  rasterizeVector: productionCookDeps.rasterizeVector,
  getTextGeometry: productionCookDeps.getTextGeometry,
  rasterizeText: productionCookDeps.rasterizeText,
  downscale: realDownscale,
  runPython: realRunPython,
  encode: realEncode,
};

/**
 * The full-res cooked raster of every pixel driver an ENABLED modifier of `node` reads, by
 * driver id (`cookNodeFullRes`, recursively). A driver already waiting further up (a cycle in
 * a document from elsewhere; attaching refuses them) is left out and reads as transparent.
 */
async function fullResDriverRasters(
  node: SceneNode,
  deps: FullResCookDeps,
  visiting: ReadonlySet<string>,
): Promise<Map<string, ImageBitmap>> {
  const out = new Map<string, ImageBitmap>();
  const enabled = { ...node, modifiers: node.modifiers.filter((m) => m.enabled) };
  const inner = new Set(visiting).add(node.id);
  for (const driverId of pixelDriversOf(enabled, deps.getMaskRef)) {
    if (inner.has(driverId)) continue;
    out.set(driverId, await cookNodeFullRes(driverId, deps, inner));
  }
  return out;
}

/**
 * One-shot full-resolution cook for export (architecture.md's "baked"
 * factor, 1 — the node's own `sourceSize`, no downscale). Never writes any
 * cache slot and never clears/sets dirty — that's the scheduler's job, not
 * export's (locking semantics for a real persisted baked cache are Epic
 * 07's). Throws on any failure (missing/unsupported node type, no decoded
 * source, sidecar error) rather than falling back to a lower-resolution
 * bitmap — export.ts must abort the whole export on this, never substitute
 * a draft upscale (epic acceptance).
 *
 * Vector nodes cook full-res too (dogfood 2026-07-06 — the old pixel-only
 * throw aborted export of ANY scene containing a vector node): their
 * "source pixels" are `rasterizeVector` at documentSize, factor 1, exactly
 * mirroring `cookNode`'s vector branch.
 */
export async function cookNodeFullRes(
  nodeId: string,
  deps: FullResCookDeps = productionFullResCookDeps,
  /** Layers whose full-res cook is waiting on this one (driver recursion's cycle guard). */
  visiting: ReadonlySet<string> = new Set(),
): Promise<ImageBitmap> {
  const rawNode = deps.getNode(nodeId);
  if (
    !rawNode ||
    (rawNode.type !== 'pixel' && rawNode.type !== 'vector' && rawNode.type !== 'text')
  ) {
    throw new Error(`node ${nodeId} is not a cookable node type`);
  }
  // Same narrowing as cookNode: the source-pixel-producing node types.
  const node = rawNode as PixelNode | VectorNode | TextNode;

  const source = node.type === 'pixel' ? deps.getSource(nodeId) : undefined;
  if (node.type === 'pixel' && !source) {
    throw new Error(`"${node.label}" has no decoded source loaded`);
  }

  const factor = 1; // full resolution — node's own extent, no downscale
  const nodeExtent = node.type === 'pixel' ? node.sourceSize : deps.getDocumentSize();
  const [width, height] = computeTargetSize(nodeExtent, factor);

  const t0 = performance.now();
  let resultBytes =
    node.type === 'pixel'
      ? deps.downscale(source as ImageBitmap, width, height)
      : node.type === 'text'
        ? deps.rasterizeText(node, await deps.getTextGeometry(node), width, height, factor)
        : deps.rasterizeVector(node.paths, node.fillRule, width, height, factor);
  // Text mask targets' geometry resolves before the sync rasterizeFor (a
  // rejection throws, aborting the export like any other cook failure).
  const maskTextGeometry = await prefetchMaskTextGeometry(node, deps);
  // Pixel drivers (layer-as-driver.md) at full res too: each cooked here, first, never a
  // lower-resolution cache (the "never substitute a draft" rule above). A failure throws.
  const drivers = await fullResDriverRasters(node, deps, visiting);
  const rasterizeFor = makeRasterizeFor(
    deps,
    maskTextGeometry,
    (id) => drivers.get(id),
    nodeExtent,
    node.transform2d ?? IDENTITY_TRANSFORM_2D,
    width,
    height,
    factor,
  );
  const rasterizeDriver = makeRasterizeDriverFor(
    deps,
    (id) => drivers.get(id),
    nodeExtent,
    node.transform2d ?? IDENTITY_TRANSFORM_2D,
    width,
    height,
    factor,
  );
  const cookModifiers = buildCookModifiers(
    node.modifiers,
    factor,
    deps.getOps(),
    rasterizeFor,
    rasterizeDriver,
  );
  // The masks are rasterised (synchronously, above): the drivers' bitmaps are done with.
  for (const bitmap of drivers.values()) (bitmap as { close?: () => void }).close?.();

  const tDownscale = performance.now();
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

  const tSidecar = performance.now();

  const bitmap = await deps.encode(resultBytes, width, height);
  useLastCookStore.getState().publish({
    nodeLabel: node.label,
    level: 'baked',
    totalMs: performance.now() - t0,
    sidecarMs: tSidecar - tDownscale,
    width,
    height,
  });
  return bitmap;
}

/**
 * Everything a node's modifier masks rasterise from that lives OUTSIDE its
 * `modifiers` array: each resolved ref + target geometry (a pixel driver's inputs and the
 * raster this level reads, layer-as-driver.md), and — when any
 * DOCUMENT-pinned mask resolves — the node's own transform2d (such masks
 * rasterise through the consumer's current frame). Mirrors `restore.ts`'s
 * `cookAffectingChanged` mask clauses.
 */
function maskInputsKey(
  node: SceneNode,
  deps: Pick<CookDeps, 'getNode' | 'getMaskRef'>,
  rasterKey: DriverRasterKey,
): string {
  const refs = node.modifiers.map((m) =>
    resolvedMaskInput(m.maskId, deps.getMaskRef, deps.getNode, rasterKey),
  );
  // a driver (Epic 27) is a cook input the same way: its numbers, its layer and the raster read
  const drivers = node.modifiers.map((m) =>
    resolvedDriverInput(m.driver, deps.getMaskRef, deps.getNode, rasterKey),
  );
  if (refs.every((r) => r === null) && drivers.every((r) => r === null)) return '';
  // Only document-pinned refs read the consumer's current transform2d
  // (mask-follows-node.md): a node-pinned mask rasterises through its own
  // attachTransform, so moving the consumer must not look like a change.
  const transform2d = hasDocumentPinnedMask(node.modifiers, deps.getMaskRef)
    ? node.transform2d
    : undefined;
  return JSON.stringify({ refs, drivers, transform2d });
}

/**
 * Pipe `bytes` through one group of modifiers: partitioned into same-backend
 * runs, one sidecar call per run (none for an empty group).
 */
async function runGroup(
  deps: Pick<CookDeps, 'runPython'>,
  width: number,
  height: number,
  group: CookModifier[],
  bytes: Uint8Array,
): Promise<Uint8Array> {
  let result = bytes;
  for (const run of partitionRuns(group)) {
    if (run.backend === 'rust') {
      // deferred: rust ops via `cook_rust` (lands with the first Rust op) —
      // no rust ops exist yet, so this branch is currently unreachable.
      throw new Error('rust op backend not yet implemented');
    }
    result = await deps.runPython(width, height, run.modifiers, result);
  }
  return result;
}

/**
 * Cook one node at one resolution level: downscale the source, run the
 * enabled modifier stack through the sidecar (partitioned by backend —
 * today that's always a single Python run, per starter-ops.md), write the
 * result to the cache, and clear dirty.
 *
 * If the node was mutated again after this cook started (its `modifiers`
 * array reference changed, or — for a text node — its `textCookKey` differs),
 * the freshly-cooked bitmap is still written
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
  if (rawNode?.type !== 'pixel' && rawNode?.type !== 'vector' && rawNode?.type !== 'text') return;
  // PixelNode/VectorNode/TextNode are the source-pixel-producing node types
  // today; the cast is safe once `type` is checked (mirrors the pattern in
  // project/import.ts).
  const node = rawNode as PixelNode | VectorNode | TextNode;

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
  // Text race guard (text-node-model.md): compare cook INPUTS, not node
  // identity — markDirty/clearDirty replace the node object too, so an
  // identity check would read every dirty flip as an edit. Taken before the
  // geometry await.
  const textKeyAtStart = isTextNode(node) ? textCookKey(node) : undefined;
  // Mask race guard: a mask-source edit (dirtyMaskRefConsumers) dirties this
  // node without touching its `modifiers`, so the reference check alone
  // would let this in-flight cook clear that fresh dirty flag.
  // A pixel driver's raster as this level reads it (layer-as-driver.md): its identity is a
  // cook input, so a driver recooking mid-cook leaves this node dirty and misses the prefix.
  const rasterKey: DriverRasterKey = (id) => deps.getDriverRaster(id, level)?.key ?? null;
  const maskKeyAtStart = maskInputsKey(node, deps, rasterKey);

  // Prefix-cache inputs (prefix-cache.md), captured synchronously beside the
  // guard keys and before any await: what this cook's bytes will be derived
  // from. The commit below re-derives them and only stores on an exact match,
  // so a mid-cook edit can never leave a prefix claiming inputs it wasn't
  // built from.
  const sourceKey = prefixCache.sourceKeyFor(node, source);
  const stackDescriptors = prefixCache.descriptorsFor(node, deps, rasterKey);
  /** True while every prefix input still reads as it did at the start of this cook. */
  const prefixInputsUnchanged = (): boolean => {
    const latest = deps.getNode(nodeId);
    if (latest?.type !== 'pixel' && latest?.type !== 'vector' && latest?.type !== 'text') {
      return false;
    }
    const latestNode = latest as PixelNode | VectorNode | TextNode;
    const [latestW, latestH] = computeTargetSize(
      latestNode.type === 'pixel' ? latestNode.sourceSize : deps.getDocumentSize(),
      factor,
    );
    return (
      latestW === width &&
      latestH === height &&
      prefixCache.sourceKeyFor(
        latestNode,
        latestNode.type === 'pixel' ? deps.getSource(nodeId) : undefined,
      ) === sourceKey &&
      prefixCache.sameDescriptors(
        prefixCache.descriptorsFor(latestNode, deps, rasterKey),
        stackDescriptors,
      )
    );
  };

  // Phase timings, logged at debug level. performance.now() reads are
  // sub-microsecond against phases costing milliseconds — measuring here
  // cannot skew the result. console.debug is invisible (and near-free)
  // unless devtools' Verbose level is on.
  const t0 = performance.now();
  try {
    const enabled = modifiersAtStart.filter((m) => m.enabled);
    const stackLength = enabled.length;
    if (stackDescriptors.length !== stackLength) {
      throw new Error('prefix descriptors are out of step with the enabled modifiers');
    }

    // Reuse check: a stored intermediate is only a hit when it was built from
    // exactly this source, at exactly this size, by an exact prefix of this
    // stack. Anything else — a miss — is today's full cook.
    const stored = deps.getPrefix(nodeId, level);
    const hit =
      stored !== undefined &&
      stored.descriptor.modifiers.length > 0 &&
      stored.descriptor.source === sourceKey &&
      stored.descriptor.width === width &&
      stored.descriptor.height === height &&
      stored.bytes.byteLength === width * height * 4 &&
      prefixCache.isPrefix(stored.descriptor.modifiers, stackDescriptors)
        ? stored
        : undefined;
    const start = hit ? hit.descriptor.modifiers.length : 0;

    // The geometry await sits inside this try: a Rust error (e.g. FontNotFound)
    // is a cook failure — one toast per burst, dirty stays, stale cache untouched.
    let resultBytes: Uint8Array;
    if (hit) {
      // Always a copy: the stored buffer stays the cache's, whatever the run
      // (or encode, when the prefix covers the whole stack) does with it.
      resultBytes = hit.bytes.slice();
    } else {
      resultBytes =
        node.type === 'pixel'
          ? deps.downscale(source as ImageBitmap, width, height)
          : node.type === 'text'
            ? deps.rasterizeText(node, await deps.getTextGeometry(node), width, height, factor)
            : deps.rasterizeVector(node.paths, node.fillRule, width, height, factor);
    }
    const tDownscale = performance.now();
    // Text mask targets' geometry (async) resolves here, inside the failure try,
    // so a Rust error is a cook failure; makeRasterizeFor stays synchronous.
    const maskTextGeometry = await prefetchMaskTextGeometry(node, deps);
    const rasterizeFor = makeRasterizeFor(
      deps,
      maskTextGeometry,
      (id) => deps.getDriverRaster(id, level)?.bitmap,
      nodeExtent,
      node.transform2d ?? IDENTITY_TRANSFORM_2D,
      width,
      height,
      factor,
    );
    // Only the not-yet-applied modifiers are built (and so only their masks
    // rasterised). The enabled-only 1:1 mapping between modifiers, descriptors
    // and CookModifiers is what makes the index arithmetic below sound.
    const pending = enabled.slice(start);
    const rasterizeDriver = makeRasterizeDriverFor(
      deps,
      (id) => deps.getDriverRaster(id, level)?.bitmap,
      nodeExtent,
      node.transform2d ?? IDENTITY_TRANSFORM_2D,
      width,
      height,
      factor,
    );
    const built = buildCookModifiers(pending, factor, deps.getOps(), rasterizeFor, rasterizeDriver);
    // Levels' histogram (levels-curve.md) rides the draft cook only: it is a 1/8 picture, so
    // counting costs nothing, and the panel needs the shape, not the pixels.
    const cookModifiers =
      level === 'draft' ? withHistograms(nodeId, built, pending, deps.getOps()) : built;
    if (cookModifiers.length !== pending.length) {
      throw new Error('buildCookModifiers no longer maps enabled modifiers 1:1');
    }
    // Mask planes were just rasterised from LIVE scene state, after an await:
    // if anything the descriptors cover moved since the start (even if it has
    // moved back by the end), these bytes aren't safe to file under them.
    const builtFromStartInputs = prefixInputsUnchanged();

    // Split point: where this stack first differs from the last one cooked is
    // where an edit is happening; everything before it is worth keeping as the
    // next prefix. Split only strictly inside the not-yet-applied range.
    const lastStack = deps.getLastStack(nodeId, level);
    const diffIdx = lastStack ? prefixCache.firstDiff(lastStack, stackDescriptors) : 0;
    const split = diffIdx > start && diffIdx < stackLength;

    let newPrefix: prefixCache.PrefixEntry | undefined;
    if (split) {
      const cut = diffIdx - start;
      resultBytes = await runGroup(deps, width, height, cookModifiers.slice(0, cut), resultBytes);
      newPrefix = {
        descriptor: {
          source: sourceKey as ImageBitmap | string,
          width,
          height,
          modifiers: stackDescriptors.slice(0, diffIdx),
        },
        // Copied: the run below must not be able to touch what we keep.
        bytes: resultBytes.slice(),
      };
      resultBytes = await runGroup(deps, width, height, cookModifiers.slice(cut), resultBytes);
    } else {
      resultBytes = await runGroup(deps, width, height, cookModifiers, resultBytes);
    }
    const tSidecar = performance.now();

    const bitmap = await deps.encode(resultBytes, width, height);
    const tEncode = performance.now();
    console.debug(
      `[cook] ${node.label} ${level} ${width}x${height}: total ${(tEncode - t0).toFixed(1)}ms ` +
        `(downscale ${(tDownscale - t0).toFixed(1)}, sidecar+ipc ${(tSidecar - tDownscale).toFixed(1)}, ` +
        `encode ${(tEncode - tSidecar).toFixed(1)}) prefix ${start}/${stackLength}`,
    );
    deps.setCache(nodeId, level, bitmap);
    // Success only: the status bar's "last cook" readout (cook-time-readout.md).
    // A throw anywhere above lands in the catch and publishes nothing.
    useLastCookStore.getState().publish({
      nodeLabel: node.label,
      level,
      totalMs: tEncode - t0,
      sidecarMs: tSidecar - tDownscale,
      width,
      height,
    });

    // Prefix commit — only now the whole cook has succeeded, and only if every
    // input it was derived from still reads as it did at the start. A failed
    // or raced cook leaves the previous entry in place.
    if (builtFromStartInputs && prefixInputsUnchanged()) {
      if (newPrefix) deps.setPrefix(nodeId, level, newPrefix);
      deps.setLastStack(nodeId, level, stackDescriptors);
    }

    const current = deps.getNode(nodeId);
    const textInputsUnchanged =
      textKeyAtStart === undefined ||
      (current !== undefined && isTextNode(current) && textCookKey(current) === textKeyAtStart);
    if (
      current &&
      current.modifiers === modifiersAtStart &&
      textInputsUnchanged &&
      maskInputsKey(current, deps, rasterKey) === maskKeyAtStart
    ) {
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
