import { create } from 'zustand';
import { useSceneStore } from '@/scene/store';

/**
 * Shared document <-> screen affine transform.
 *
 * Screen space here means "canvas-local CSS pixels" (i.e. the coordinate
 * space you get from `getBoundingClientRect()`-relative pointer coords).
 * devicePixelRatio is a paint-time concern only — it scales the canvas
 * backing store, never scale/tx/ty. The SVG overlay matrix uses these raw
 * values too, so canvas paint and overlay geometry never drift apart.
 */
export interface ViewTransform {
  scale: number; // document px -> screen px multiplier
  tx: number; // screen-space translation x
  ty: number; // screen-space translation y
}

export const MIN_SCALE = 1 / 32;
export const MAX_SCALE = 32;

export interface Point {
  x: number;
  y: number;
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Document-space point -> screen-space point. */
export function docToScreen(view: ViewTransform, p: Point): Point {
  return { x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty };
}

/** Screen-space point -> document-space point (inverse of docToScreen). */
export function screenToDoc(view: ViewTransform, p: Point): Point {
  return { x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale };
}

/**
 * Zoom the view by `factor` while keeping the document point currently
 * under `cursor` (screen space) fixed under that same screen point.
 */
export function zoomAt(view: ViewTransform, cursor: Point, factor: number): ViewTransform {
  const docPt = screenToDoc(view, cursor);
  const nextScale = clampScale(view.scale * factor);
  return {
    scale: nextScale,
    tx: cursor.x - docPt.x * nextScale,
    ty: cursor.y - docPt.y * nextScale,
  };
}

/** Pan the view by a screen-space delta. */
export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy };
}

/** Scale + centre so the full document rect fits inside the viewport. */
export function fitTransform(
  viewportW: number,
  viewportH: number,
  docW: number,
  docH: number,
): ViewTransform {
  if (viewportW <= 0 || viewportH <= 0 || docW <= 0 || docH <= 0) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const scale = clampScale(Math.min(viewportW / docW, viewportH / docH));
  const tx = (viewportW - docW * scale) / 2;
  const ty = (viewportH - docH * scale) / 2;
  return { scale, tx, ty };
}

/** Scale 1:1, centred in the viewport. */
export function reset100Transform(
  viewportW: number,
  viewportH: number,
  docW: number,
  docH: number,
): ViewTransform {
  const scale = 1;
  const tx = (viewportW - docW * scale) / 2;
  const ty = (viewportH - docH * scale) / 2;
  return { scale, tx, ty };
}

interface ViewTransformState {
  view: ViewTransform;
  /** Latest viewport (canvas CSS) size, kept for fit/reset shortcuts. */
  viewportW: number;
  viewportH: number;
  /** Document (full-resolution) dimensions. */
  docW: number;
  docH: number;
  /** Cursor position in document space, or null if outside canvas. */
  cursorDoc: Point | null;
  setView: (view: ViewTransform) => void;
  setViewportSize: (w: number, h: number) => void;
  setCursorDoc: (cursor: Point | null) => void;
  fitToWindow: () => void;
  reset100: () => void;
}

export const useViewTransformStore = create<ViewTransformState>((set, get) => ({
  view: { scale: 1, tx: 0, ty: 0 },
  viewportW: 0,
  viewportH: 0,
  // No document until the first pixel node is imported (scene-store.md).
  docW: 0,
  docH: 0,
  cursorDoc: null,
  setView: (view) => set({ view }),
  setViewportSize: (w, h) => set({ viewportW: w, viewportH: h }),
  setCursorDoc: (cursor) => set({ cursorDoc: cursor }),
  fitToWindow: () => {
    const { viewportW, viewportH, docW, docH } = get();
    set({ view: fitTransform(viewportW, viewportH, docW, docH) });
  },
  reset100: () => {
    const { viewportW, viewportH, docW, docH } = get();
    set({ view: reset100Transform(viewportW, viewportH, docW, docH) });
  },
}));

// Keep docW/docH in lockstep with `scene.documentSize` — the scene store is
// the source of truth (set once, from the first imported pixel node; see
// `project/import.ts`), this store only mirrors it for paint/fit math. Fit
// the window the first time a real document appears (0x0 -> non-zero),
// same "first real size" pattern `Viewport.tsx` uses for the viewport size.
useSceneStore.subscribe((state, prev) => {
  const [w, h] = state.scene.documentSize;
  const [prevW, prevH] = prev.scene.documentSize;
  if (w === prevW && h === prevH) return;

  const hadDocument =
    useViewTransformStore.getState().docW > 0 && useViewTransformStore.getState().docH > 0;
  useViewTransformStore.setState({ docW: w, docH: h });
  if (!hadDocument && w > 0 && h > 0) {
    useViewTransformStore.getState().fitToWindow();
  }
});
