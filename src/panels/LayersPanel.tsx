import { layerNodes } from '@/panels/stack/dragReorder';
import { LayerList } from '@/panels/stack/LayerList';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';

/**
 * The Layers tab of the left panel (layers-left.md): `LayerList`, the picker for the node whose
 * modifiers the Properties tab shows, with the no-layers empty state. The list scrolls inside its
 * tab, so it can be as long as it likes without pushing the modifier stack down.
 */
export function LayersPanel() {
  const nodes = useSceneStore((s) => s.scene.nodes);
  const selection = useSelectionStore((s) => s.selection);
  const selectNode = useSelectionStore((s) => s.selectNode);

  if (layerNodes(nodes).length === 0) {
    return (
      <div className="flex flex-col gap-3 text-sm text-neutral-200">
        <div className="text-neutral-500">No layers yet — import an image.</div>
      </div>
    );
  }

  return (
    <LayerList
      selectedNodeId={selection.kind === 'node' ? selection.nodeId : null}
      onSelectNode={selectNode}
    />
  );
}
