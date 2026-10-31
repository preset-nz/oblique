/**
 * Pure geometry + index arithmetic for drag-to-reorder (drag-reorder.md).
 * No DOM, no store — `useDragReorder` measures rows and feeds the numbers in.
 *
 * Everything here works in DISPLAY order (index 0 = the top row on screen).
 * Layer rows are already in model order (index 0 = top of the stack); modifier
 * rows are reversed (`stackOrder.ts`), so the modifier list converts the
 * result of `moveTarget` with `invertIndex` before calling `reorderModifier`.
 */

import { isSelectionNode, type SceneNode } from '@/scene/types';

export interface RowRect {
  top: number;
  bottom: number;
}

/**
 * The gap index (0..n) the pointer is nearest, using row midpoints: gap `i`
 * sits above row `i`, gap `n` below the last row. `rowRects` must be sorted
 * top-to-bottom. A pointer exactly on a midpoint falls to the lower gap.
 */
export function insertionIndexFor(pointerY: number, rowRects: readonly RowRect[]): number {
  let gap = 0;
  for (const rect of rowRects) {
    if ((rect.top + rect.bottom) / 2 < pointerY) gap++;
    else break;
  }
  return gap;
}

/**
 * Converts a gap index into the `toIndex` a remove-then-insert reorder
 * (`reorderNode` / `reorderModifier`: splice out, splice in) expects, or
 * `null` when the move is a no-op — dropping into the gap directly above
 * (`fromIndex`) or below (`fromIndex + 1`) the row itself.
 */
export function moveTarget(fromIndex: number, insertionIndex: number): number | null {
  if (insertionIndex === fromIndex || insertionIndex === fromIndex + 1) return null;
  return insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
}

/**
 * Y coordinate (same space as `rowRects`) of the drop-indicator line for gap
 * `insertionIndex`: the middle of the space between the two neighbouring
 * rows, or flush with the outer edge of the first/last row. `null` for an
 * empty list.
 */
export function insertionLineY(
  insertionIndex: number,
  rowRects: readonly RowRect[],
): number | null {
  const n = rowRects.length;
  if (n === 0) return null;
  if (insertionIndex <= 0) return rowRects[0].top;
  if (insertionIndex >= n) return rowRects[n - 1].bottom;
  return (rowRects[insertionIndex - 1].bottom + rowRects[insertionIndex].top) / 2;
}

export type LayerMove = 'forward' | 'backward' | 'front' | 'back';

/**
 * Target `reorderNode` index for the Layer menu (Bring Forward / Send
 * Backward / Bring to Front / Send to Back), or `null` at the stack edge.
 * Index 0 is the top of the stack, so "forward" is index - 1.
 */
export function layerMoveTarget(index: number, length: number, move: LayerMove): number | null {
  if (index < 0 || index >= length) return null;
  const target =
    move === 'forward'
      ? index - 1
      : move === 'backward'
        ? index + 1
        : move === 'front'
          ? 0
          : length - 1;
  if (target < 0 || target >= length || target === index) return null;
  return target;
}

/**
 * The nodes the layer list shows, in stack order: everything but the saved selections, which
 * have their own tab (selections-panel.md). A row's position here is its DISPLAY index; its
 * position in `scene.nodes` is its REAL index, and `reorderNode` takes real ones. The helpers
 * below are the one place the two are converted.
 */
export function layerNodes(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.filter((n) => !isSelectionNode(n));
}

/**
 * The real `toIndex` for `reorderNode` that lands a layer in display slot `toDisplay`
 * (`moveTarget`'s result, or `layerMoveTarget`'s), or `null` when either end is out of range.
 * Landing in the slot of the layer currently there means taking that layer's real index: the
 * remove-then-insert splice puts the moved node just before it going up and just after it going
 * down, and any selection nodes between the two stay where they were relative to the others.
 */
export function layerRealIndex(nodes: readonly SceneNode[], toDisplay: number): number | null {
  const target = layerNodes(nodes)[toDisplay];
  if (!target) return null;
  return nodes.indexOf(target);
}

/** A layer-list drop: the dragged row's display index and the display `toIndex` -> the node and its real `toIndex`. */
export function layerDrop(
  nodes: readonly SceneNode[],
  fromDisplay: number,
  toDisplay: number,
): { id: string; toIndex: number } | null {
  const moved = layerNodes(nodes)[fromDisplay];
  const toIndex = layerRealIndex(nodes, toDisplay);
  if (!moved || toIndex === null) return null;
  return { id: moved.id, toIndex };
}

/**
 * The Layer menu's move for node `id` as a real `reorderNode` index, counted among the layers
 * the list shows (a hidden selection node is never a stop), or `null` for a no-op: the edge of
 * the stack, an unknown node, or a selection node, which isn't in the layer order the menu moves.
 */
export function layerMoveRealIndex(
  nodes: readonly SceneNode[],
  id: string,
  move: LayerMove,
): number | null {
  const layers = layerNodes(nodes);
  const from = layers.findIndex((n) => n.id === id);
  const to = layerMoveTarget(from, layers.length, move);
  return to === null ? null : layerRealIndex(nodes, to);
}
