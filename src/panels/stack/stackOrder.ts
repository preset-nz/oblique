/**
 * Bottom-to-top display ordering (epic README § "Stack direction decision").
 *
 * The scene-model `node.modifiers` array is APPLICATION order: index 0
 * applies first, the last index applies last (unchanged by this epic — see
 * `store.ts`'s `reorderModifier`, `cook.ts`'s `buildCookModifiers`).
 *
 * The stack UI displays this reversed, layer-stack style: the bottom row
 * (last in the rendered list) is the first-applied modifier, the top row
 * (first in the rendered list) is the last-applied. `toDisplayOrder` is
 * exactly `[...modifiers].reverse()`; because a reversal is its own
 * inverse, one `invertIndex` function converts an index in either
 * direction — this is the one place the display flip has to be undone
 * before calling `reorderModifier` (which operates on the model array),
 * so it is kept pure and tested in isolation from any component.
 */

/** Reversed copy of `items` — model order in, display order out (or vice versa; self-inverse). */
export function toDisplayOrder<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

/** Converts an index from one ordering to the other (model<->display); a reversal is its own inverse. */
export function invertIndex(index: number, length: number): number {
  return length - 1 - index;
}

/**
 * Target *display* index for nudging a row 'up' (toward the displayed top
 * = last-applied) or 'down' (toward the displayed bottom = first-applied),
 * or `null` if the row is already at that edge. Pure index arithmetic,
 * independent of which ordering the caller is in — mirrors
 * `LayerList.nudgeIndex`.
 */
export function nudgeDisplayIndex(
  displayIndex: number,
  direction: 'up' | 'down',
  length: number,
): number | null {
  const target = direction === 'up' ? displayIndex - 1 : displayIndex + 1;
  if (target < 0 || target >= length) return null;
  return target;
}

/**
 * Target scene-model index for nudging a row currently at `displayIndex`,
 * or `null` at the edge. This is the function reorder UI should call:
 * it does the nudge in display terms (matching what the user sees) and
 * then undoes the bottom-to-top flip to get the model index `reorderModifier`
 * expects.
 */
export function nudgeModelIndex(
  displayIndex: number,
  direction: 'up' | 'down',
  length: number,
): number | null {
  const targetDisplay = nudgeDisplayIndex(displayIndex, direction, length);
  if (targetDisplay === null) return null;
  return invertIndex(targetDisplay, length);
}
