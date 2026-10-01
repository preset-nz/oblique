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
 * before calling `reorderModifier` (which operates on the model array)
 * with a drop target from `dragReorder.ts`'s `moveTarget`, so it is kept
 * pure and tested in isolation from any component.
 */

/** Reversed copy of `items` — model order in, display order out (or vice versa; self-inverse). */
export function toDisplayOrder<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

/** Converts an index from one ordering to the other (model<->display); a reversal is its own inverse. */
export function invertIndex(index: number, length: number): number {
  return length - 1 - index;
}
