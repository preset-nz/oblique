/**
 * Pure geometry + index arithmetic for drag-to-reorder (drag-reorder.md).
 * No DOM, no store — `useDragReorder` measures rows and feeds the numbers in.
 *
 * Everything here works in DISPLAY order (index 0 = the top row on screen).
 * Layer rows are already in model order (index 0 = top of the stack); modifier
 * rows are reversed (`stackOrder.ts`), so the modifier list converts the
 * result of `moveTarget` with `invertIndex` before calling `reorderModifier`.
 */

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
