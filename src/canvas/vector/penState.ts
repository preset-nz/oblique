import { create } from 'zustand';
import { usePathEditStateStore } from '@/scene/pathEditState';
import type { Selection } from '@/scene/selection';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import type { AnchorPoint, Point2D, Scene, SceneNode, VectorNode, VectorPath } from '@/scene/types';
import { isVectorNode } from '@/scene/types';
import { editingDeltaFor } from '../maskDisplayTransform';
import { mapVectorPaths } from './vectorTransform';

/**
 * The in-progress pen path (features/06-vector-nodes/pen-tool.md). Ephemeral
 * *view* state, one path being drawn at a time — same role `scene/marquee.ts`
 * plays for the selection tools, but this one lives in `canvas/` rather than
 * `scene/`: nothing in `panels/` needs to read an in-progress pen path (the
 * Vectors tab, vectors-tab.md, only ever looks at a *finished* VectorNode in
 * the scene store), so there's no cross-layer reason to push it down through
 * `scene/` the way the marquee had to. `finishClosed`/`finishOpen` are the
 * one place this store touches the scene: they call `addVectorNode` exactly
 * once (one undo step: no `beginTransaction`/`endTransaction` needed, this isn't a
 * coalesced drag)
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

/**
 * pen-append-to-node.md's "selection decides" rule: the currently selected
 * node is a valid append target iff it's a vector node and it's unlocked
 * (Epic 07's `state: 'locked'` guards `setVectorPaths` at the store boundary
 * anyway, but deciding here — rather than relying on that silent no-op — is
 * what lets a locked selection fall through to "create a new node" instead of
 * the shape just vanishing into a no-op). Shared by `commit()` (imperative,
 * `getState()`) and `usePenAppendTarget()` (reactive, for `PenTool.tsx`'s
 * on-canvas cue) so the two can never disagree about the target.
 */
function resolveAppendTarget(selection: Selection, nodes: SceneNode[]): VectorNode | null {
  if (selection.kind !== 'node') return null;
  const node = nodes.find((n) => n.id === selection.nodeId);
  if (!node || !isVectorNode(node) || node.state === 'locked') return null;
  return node;
}

/** Reactive form of `resolveAppendTarget`, for `PenTool.tsx`'s preview cue — the node id a finished shape would append to, or `null` if it will start a new node. */
export function usePenAppendTargetId(): string | null {
  const selection = useSelectionStore((s) => s.selection);
  const nodes = useSceneStore((s) => s.scene.nodes);
  return resolveAppendTarget(selection, nodes)?.id ?? null;
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

/**
 * Anchors are placed at pointer positions (document space, where the shape is
 * DISPLAYED). Appending to a node-pinned mask's shape whose consumer has moved
 * (mask-follows-node.md): map them back through the inverse of the editing
 * delta so what's stored stays the shape's own document-space geometry and the
 * new path lands where it was drawn. Identity delta (every other case) returns
 * the anchors untouched.
 */
function anchorsForStorage(anchors: AnchorPoint[], targetId: string, scene: Scene): AnchorPoint[] {
  const delta = editingDeltaFor(targetId, scene);
  if (delta.identity) return anchors;
  return mapVectorPaths([{ anchors, closed: false }], delta.fromDisplay)[0].anchors;
}

function commit(anchors: AnchorPoint[], closed: boolean): void {
  const { selection } = useSelectionStore.getState();
  const { scene, setVectorPaths } = useSceneStore.getState();
  const target = resolveAppendTarget(selection, scene.nodes);
  const newPath: VectorPath = {
    anchors: target ? anchorsForStorage(anchors, target.id, scene) : anchors,
    closed,
  };

  if (target) {
    const pathIndex = target.paths.length;
    setVectorPaths(target.id, [...target.paths, newPath]);
    // `target` came from the CURRENT selection (`resolveAppendTarget`), so
    // it's already selected — deliberately no `selectNode` call here: a
    // fresh selection object would risk retriggering any
    // selection-change-clears-activeAnchor wiring (`pathEditState.ts`) and
    // wiping the focus set below before the Vectors tab ever paints it.
    usePathEditStateStore.getState().setActiveAnchor({ pathIndex, anchorIndex: 0 });
    return;
  }

  const id = useSceneStore.getState().addVectorNode({
    paths: [newPath],
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
