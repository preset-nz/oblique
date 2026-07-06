import type { SceneNode } from '@/scene/types';

/**
 * Pure lock-UI helpers (lock-ui.md) — kept out of LayerList/StackRow so the
 * disabled-state logic is unit-testable without mounting React. The store
 * (`state === 'locked'`, `bakingNodeIds`) stays the single source of truth;
 * these functions only translate that state into what a control should
 * show/allow.
 */

/** Node's own lock flag — the unit locked is the node, never a modifier. */
export function isNodeLocked(node: Pick<SceneNode, 'state'>): boolean {
  return node.state === 'locked';
}

/** True while this node's one-shot full-res bake cook is in flight. */
export function isNodeBaking(nodeId: string, bakingNodeIds: ReadonlySet<string>): boolean {
  return bakingNodeIds.has(nodeId);
}

export type PadlockVisualState = 'active' | 'locked' | 'baking';

/**
 * What the padlock control should render/announce. Baking takes priority
 * over the node's current `state` (a locked→unlock→relock cycle briefly
 * has `state: 'active'` while baking) — the in-progress affordance always
 * wins so the row never flashes an inconsistent icon mid-bake.
 */
export function padlockVisualState(
  node: Pick<SceneNode, 'state'>,
  nodeId: string,
  bakingNodeIds: ReadonlySet<string>,
): PadlockVisualState {
  if (isNodeBaking(nodeId, bakingNodeIds)) return 'baking';
  return isNodeLocked(node) ? 'locked' : 'active';
}

/** Padlock click is ignored while a bake is already in flight for this node. */
export function padlockClickIgnored(nodeId: string, bakingNodeIds: ReadonlySet<string>): boolean {
  return isNodeBaking(nodeId, bakingNodeIds);
}

export function padlockAriaLabel(state: PadlockVisualState): string {
  switch (state) {
    case 'baking':
      return 'Baking…';
    case 'locked':
      return 'Unlock layer';
    case 'active':
      return 'Lock layer';
  }
}

/**
 * A locked node's stack rows/ops-palette go read-only — every cook-dirtying
 * control (params, add/remove/reorder/enable modifiers, mask apply) is
 * inert. Compositing controls (opacity/blend/visibility/rename/reorder)
 * never consult this — they stay live per the epic's "lock freezes the
 * cook, not the compositing" decision.
 */
export function stackControlsDisabled(node: Pick<SceneNode, 'state'>): boolean {
  return isNodeLocked(node);
}

export const LOCKED_HINT = 'Locked — unlock to edit';
