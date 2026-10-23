import { isSegmentableNode } from '@/canvas/selectShared/isSegmentableNode';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';

/**
 * An armed Smart Select / Colour Select with no target adopts the next
 * selected pixel, vector or text node (import-selects.md): arm the tool then
 * import, or arm it then click a layer in the list. The tool is ready for a
 * click afterwards, with its "Select an image or vector layer…" status
 * cleared.
 *
 * A tool that already has a target never follows selection changes (its
 * target "must stay selected" rule is unchanged), and the outline seed is not
 * run here: that gesture belongs to activation only.
 *
 * `isArmed` is injected so this module doesn't import `toolState`; each
 * store passes its own predicate. Installed once at module load beside
 * `clearWhenTargetGone`. Returns the unsubscribe for tests.
 */
export function adoptSelectedTarget(opts: {
  getTargetNodeId: () => string | null;
  setTarget: (nodeId: string) => void;
  setStatus: (status: 'idle') => void;
  isArmed: () => boolean;
}): () => void {
  return useSelectionStore.subscribe((state, prev) => {
    if (state.selection === prev.selection) return;
    if (state.selection.kind !== 'node') return;
    if (!opts.isArmed() || opts.getTargetNodeId() !== null) return;
    const { nodeId } = state.selection;
    const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
    if (!isSegmentableNode(node)) return;
    opts.setTarget(nodeId);
    opts.setStatus('idle');
  });
}
