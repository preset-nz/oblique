/** Document-px direction per arrow key for the selected-node nudge. */
const NUDGE_DELTA: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The nudge direction for a keydown, or null when it isn't one (node-transform-2d.md §Tools).
 * Only the bare arrows count, with Shift for the larger step: Opt+Up and Opt+Down are Layer >
 * Bring Forward and Send Backward (menu standard decision 3), so a chord that reaches the webview
 * must never also nudge, and Cmd and Ctrl with an arrow belong to the platform.
 */
export function nudgeDirection(e: {
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): [number, number] | null {
  if (e.altKey || e.metaKey || e.ctrlKey) return null;
  return NUDGE_DELTA[e.key] ?? null;
}
