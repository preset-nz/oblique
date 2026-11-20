import { useEffect } from 'react';
import { layerNodes } from '@/panels/stack/dragReorder';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';

/**
 * Repairs a selection that points at a DELETED node by falling back to the top layer. Mounted once
 * in `Layout`, outside both side panels: a collapsed SidePanel and an inactive tab unmount their
 * children, so an effect inside the Properties tab would miss a delete made while it was hidden
 * (layers-left.md).
 *
 * `kind: 'none'` is a legitimate state: Escape deselects and must stay deselected (dogfood
 * 2026-07-05), so this never auto-selects out of it.
 */
export function useSelectionRepair(): void {
  const nodes = useSceneStore((s) => s.scene.nodes);
  const selection = useSelectionStore((s) => s.selection);
  const selectNode = useSelectionStore((s) => s.selectNode);
  useEffect(() => {
    if (selection.kind !== 'node') return;
    if (nodes.some((n) => n.id === selection.nodeId)) return;
    // The first LAYER: a saved selection can sit at the top, and it isn't in the list.
    const top = layerNodes(nodes)[0];
    if (top) selectNode(top.id);
  }, [nodes, selection, selectNode]);
}
