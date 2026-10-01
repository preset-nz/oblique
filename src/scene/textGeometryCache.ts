import { create } from 'zustand';
import { effectiveFontFor } from '@/fonts/effectiveFont';
import { textOutlines } from '@/fonts/fontsIpc';
import type { TextGeometry, TextSpec } from '@/fonts/textGeometry';
import type { AnchorPoint, Point2D, TextNode, VectorPath } from './types';

/**
 * Module-scope text geometry cache (text-node-model.md), same pattern as
 * `sources.ts`/`cache.ts`: lives outside the persisted scene. Keyed by the spec
 * (NOT node id) so identical specs share an entry and undo/redo gets free hits.
 * `position`, `fill`, `stroke` and `transform2d` are not part of the spec —
 * geometry is in anchor space, so moving or recolouring never calls Rust.
 */

const MAX_ENTRIES = 128;

const cache = new Map<string, TextGeometry>();
const inFlight = new Map<string, Promise<TextGeometry>>();

/** Bumped on every insert so overlays that read `getGeometry` re-render. */
export const useTextGeometryStore = create<{ version: number }>(() => ({ version: 0 }));

/** The Rust-facing spec. Always resolves the font through `effectiveFontFor`. */
export function specFor(node: TextNode): TextSpec {
  return {
    content: node.content,
    postscriptName: effectiveFontFor(node).postscriptName,
    fontSize: node.fontSize,
    tracking: node.tracking,
    kerning: node.kerning,
    lineHeight: node.lineHeight,
    align: node.align,
  };
}

/** JSON with a fixed key order, so equal specs always produce equal keys. */
export function specKey(spec: TextSpec): string {
  return JSON.stringify({
    content: spec.content,
    postscriptName: spec.postscriptName,
    fontSize: spec.fontSize,
    tracking: spec.tracking,
    kerning: spec.kerning,
    lineHeight: spec.lineHeight,
    align: spec.align,
  });
}

/**
 * Everything a text cook reads: the spec plus the raster-time inputs (position,
 * fill, stroke). cook.ts's race guard compares this, not node identity —
 * markDirty/clearDirty replace the node object too.
 */
export function textCookKey(node: TextNode): string {
  return (
    specKey(specFor(node)) +
    JSON.stringify({ position: node.position, fill: node.fill, stroke: node.stroke })
  );
}

/**
 * A text node's glyph paths in DOCUMENT space (text-modifier-masks.md): every
 * anchor point and handle translated by `node.position`. Pure — `geometry` is
 * the anchor-space result from the cache/Rust, so moving the text never needs
 * Rust. Handles are absolute coordinates (AnchorPoint's contract), so they
 * translate exactly like points.
 */
export function documentPathsFor(node: TextNode, geometry: TextGeometry): VectorPath[] {
  const { x: dx, y: dy } = node.position;
  const shift = (p: Point2D): Point2D => ({ x: p.x + dx, y: p.y + dy });
  return geometry.paths.map((path) => ({
    closed: path.closed,
    anchors: path.anchors.map((a): AnchorPoint => {
      const out: AnchorPoint = { point: shift(a.point) };
      if (a.handleIn) out.handleIn = shift(a.handleIn);
      if (a.handleOut) out.handleOut = shift(a.handleOut);
      return out;
    }),
  }));
}

function insert(key: string, geometry: TextGeometry): void {
  cache.delete(key);
  cache.set(key, geometry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  useTextGeometryStore.setState((s) => ({ version: s.version + 1 }));
}

/** Cached geometry only (sync). A hit refreshes its LRU position. */
export function getGeometry(node: TextNode): TextGeometry | undefined {
  const key = specKey(specFor(node));
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** cache -> in-flight dedup -> Rust. A rejection is NOT cached. */
export function ensureGeometry(node: TextNode): Promise<TextGeometry> {
  const spec = specFor(node);
  const key = specKey(spec);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = textOutlines(spec).then(
    (geometry) => {
      inFlight.delete(key);
      insert(key, geometry);
      return geometry;
    },
    (err: unknown) => {
      inFlight.delete(key);
      throw err;
    },
  );
  inFlight.set(key, request);
  return request;
}

/** Tests. */
export function clearAll(): void {
  cache.clear();
  inFlight.clear();
}
