import { create } from 'zustand';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import type { AnchorPoint, Point2D } from '@/scene/types';

/**
 * The in-progress pen path (features/06-vector-nodes/pen-tool.md). Ephemeral
 * *view* state, one path being drawn at a time — same role `scene/marquee.ts`
 * plays for the selection tools, but this one lives in `canvas/` rather than
 * `scene/`: nothing in `panels/` needs to read an in-progress pen path (the
 * Vectors tab, vectors-tab.md, only ever looks at a *finished* VectorNode in
 * the scene store), so there's no cross-layer reason to push it down through
 * `scene/` the way the marquee had to. `finishClosed`/`finishOpen` are the
 * one place this store touches the scene: they call `addVectorNode` exactly
 * once (one history entry, per `scene/history.ts`'s always-on subscription —
 * no `beginTransaction`/`endTransaction` needed, this isn't a coalesced drag)
 * and then reset to empty, ready for the next shape (the tool stays active,
 * "draws several shapes in a row" per the story).
 *
 * Deliberately never mutates the scene per anchor placed — only finishing
 * (via `finishClosed`/`finishOpen`) reaches the scene store, so Escape
 * (`cancel`) or a tool switch away can always discard `anchors` with zero
 * scene/undo footprint, exactly like a cancelled marquee.
 */

const MIN_ANCHORS_TO_CLOSE = 3;
const MIN_ANCHORS_TO_FINISH_OPEN = 2;

/** Mirrors `handleOut` through `point` to derive the matching `handleIn` for a smooth anchor. */
function mirrorHandle(point: Point2D, handleOut: Point2D): Point2D {
  return { x: 2 * point.x - handleOut.x, y: 2 * point.y - handleOut.y };
}

interface PenStateStore {
  anchors: AnchorPoint[];
  /** Live pointer position, document space — drives the rubber-band segment. `null` when the pointer has left the canvas. */
  cursor: Point2D | null;
  /** Plain click: a corner anchor (no handles, straight segments either side). */
  placeCorner: (point: Point2D) => void;
  /** Click-drag: a smooth anchor — `handleOut` is the drag point, `handleIn` mirrors it through `point`. */
  placeSmooth: (point: Point2D, handleOut: Point2D) => void;
  setCursor: (point: Point2D | null) => void;
  /** Escape / tool-switch-away: discards the path, no scene mutation (epic acceptance). */
  cancel: () => void;
  /** Click-on-first-anchor or Enter with >= 3 anchors: closes the path and commits a VectorNode. No-op below the threshold. */
  finishClosed: () => void;
  /** Enter with exactly 2 anchors: commits an open VectorNode (legal data, rasterises to nothing filled). No-op otherwise. */
  finishOpen: () => void;
  /** Enter: closes if there are enough anchors to close, else finishes open, else no-op — one call site for `Viewport.tsx`'s keydown handler. */
  finishOnEnter: () => void;
}

function commit(anchors: AnchorPoint[], closed: boolean): void {
  const id = useSceneStore.getState().addVectorNode({
    paths: [{ anchors, closed }],
    fillRule: 'nonzero',
    output: 'image',
  });
  useSelectionStore.getState().selectNode(id);
}

export const usePenStateStore = create<PenStateStore>((set, get) => ({
  anchors: [],
  cursor: null,
  placeCorner: (point) => set((s) => ({ anchors: [...s.anchors, { point }] })),
  placeSmooth: (point, handleOut) =>
    set((s) => ({
      anchors: [...s.anchors, { point, handleOut, handleIn: mirrorHandle(point, handleOut) }],
    })),
  setCursor: (point) => set({ cursor: point }),
  cancel: () => set({ anchors: [], cursor: null }),
  finishClosed: () => {
    const { anchors } = get();
    if (anchors.length < MIN_ANCHORS_TO_CLOSE) return;
    commit(anchors, true);
    set({ anchors: [], cursor: null });
  },
  finishOpen: () => {
    const { anchors } = get();
    if (anchors.length < MIN_ANCHORS_TO_FINISH_OPEN) return;
    commit(anchors, false);
    set({ anchors: [], cursor: null });
  },
  finishOnEnter: () => {
    const { anchors, finishClosed, finishOpen } = get();
    if (anchors.length >= MIN_ANCHORS_TO_CLOSE) finishClosed();
    else if (anchors.length >= MIN_ANCHORS_TO_FINISH_OPEN) finishOpen();
  },
}));

export { MIN_ANCHORS_TO_CLOSE, MIN_ANCHORS_TO_FINISH_OPEN };
