import type { TextGeometry } from '@/fonts/textGeometry';
import { IDENTITY_TRANSFORM_2D, type TextNode } from '@/scene/types';
import { localToWorld, type NodeExtent, type Point } from '../transform2d';

/**
 * Pure geometry for `TextBounds` (text-tool-and-inspector.md).
 * A text node's geometry is in anchor space; adding `position` puts it in the
 * node's local space, which is the document-sized raster frame (the same frame
 * a vector node's paths live in). `localToWorld` through `transform2d` then
 * gives document space — exactly the mapping the compositor applies, so the
 * overlay stays on the painted glyphs after a Move-tool drag.
 */

/** The text raster spans the document (store/compositor convention), so that is its extent. */
export function textExtent(documentSize: readonly [number, number]): NodeExtent {
  return { w: documentSize[0], h: documentSize[1] };
}

/** Glyph bounds translated by `position` — node-local space. Null until geometry with bounds exists. */
export function textBoundsLocal(
  node: TextNode,
  geometry: TextGeometry | undefined,
): { x: number; y: number; w: number; h: number } | null {
  const b = geometry?.bounds;
  if (!b) return null;
  return { x: b.x + node.position.x, y: b.y + node.position.y, w: b.w, h: b.h };
}

/** The four corners of the glyph bounds in document space (empty when there are no bounds). */
export function boundsCornersDoc(
  node: TextNode,
  geometry: TextGeometry | undefined,
  documentSize: readonly [number, number],
): Point[] {
  const r = textBoundsLocal(node, geometry);
  if (!r) return [];
  const t = node.transform2d ?? IDENTITY_TRANSFORM_2D;
  const extent = textExtent(documentSize);
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((p) => localToWorld(p, t, extent));
}

export interface ClickRecord {
  /** `PointerEvent.timeStamp`, ms. */
  t: number;
  /** Client (screen) coordinates. */
  x: number;
  y: number;
  nodeId: string;
}

export const DOUBLE_CLICK_MS = 400;
export const DOUBLE_CLICK_SCREEN_PX = 5;

/**
 * Two primary pointerdowns on the same node, close in time and screen distance.
 * Pointer Events only (repo hard rule), so `dblclick` isn't available.
 */
export function isDoubleClick(prev: ClickRecord | null, next: ClickRecord): boolean {
  if (!prev || prev.nodeId !== next.nodeId) return false;
  if (next.t - prev.t > DOUBLE_CLICK_MS) return false;
  return Math.hypot(next.x - prev.x, next.y - prev.y) <= DOUBLE_CLICK_SCREEN_PX;
}
