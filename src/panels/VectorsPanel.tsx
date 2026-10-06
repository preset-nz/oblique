import { Icons } from '@preset.nz/ux-kit';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { deleteNode } from '@/scene/deleteNode';
import { usePathEditStateStore } from '@/scene/pathEditState';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import type { NodeOutput, VectorNode, VectorPath } from '@/scene/types';
import { isVectorNode } from '@/scene/types';
import { nudgeIndex } from './stack/LayerList';
import { deletePath, reorderPath } from './vectors/pathList';

// Base UI's Select shows the raw value unless the root is told each value's label.
const FILL_RULE_ITEMS = [
  { value: 'nonzero', label: 'Nonzero' },
  { value: 'evenodd', label: 'Even-odd' },
];
const OUTPUT_ITEMS = [
  { value: 'image', label: 'Image' },
  { value: 'mask', label: 'Mask' },
];

/**
 * Vectors tab (vectors-tab.md) — housekeeping for a vector node's `paths`
 * without hunting for anchors on canvas. Panel-scoped: imports nothing from
 * `src/canvas/` (depcruise rule); meets the overlay through
 * `scene/pathEditState.ts`, the same shared "active anchor" store
 * `PathEditor.tsx` reads to paint its amber highlight — clicking a row here
 * sets `{ pathIndex, anchorIndex: 0 }`, focusing that path's first anchor,
 * so a row click and an on-canvas anchor click can never disagree about
 * what's "active" (see that store's doc comment for why there's no separate
 * path-only concept).
 *
 * Delete/reorder route through `useSceneStore.setVectorPaths` — the same
 * coarse "replace paths wholesale" action `path-editing.md`'s `PathEditor`
 * already uses, so dirtying (raster changed -> recook, dirty rule 1) and the
 * cross-node maskRef dirty (vector-modifier-masks.md) live in exactly one
 * place regardless of which UI triggered the edit. `fillRule`/`output` are
 * node-level controls: `fillRule` changes the raster (own dirtying action,
 * `setVectorFillRule`); `output` is compositing-only (`setNodeProp`, dirty
 * rule 4), same toggle `LayerList.tsx`'s layer-row icon-button already
 * exposes — this is the "revisit when the Vectors tab exists" surface the
 * epic README flagged.
 *
 * Text nodes (text-node.md, not yet built) will share this same empty-state
 * gate once `isTextNode` exists — deferred: text-node.md.
 */

function pathLabel(path: VectorPath, index: number): string {
  const count = path.anchors.length;
  const anchors = `${count} anchor${count === 1 ? '' : 's'}`;
  return `Path ${index + 1} — ${anchors}${path.closed ? '' : ', open'}`;
}

function PathRow({
  node,
  path,
  index,
  length,
  focused,
  onFocus,
}: {
  node: VectorNode;
  path: VectorPath;
  index: number;
  length: number;
  focused: boolean;
  onFocus: () => void;
}) {
  const setVectorPaths = useSceneStore((s) => s.setVectorPaths);
  const clearActiveAnchor = usePathEditStateStore((s) => s.clear);

  const up = nudgeIndex(index, 'up', length);
  const down = nudgeIndex(index, 'down', length);

  function handleReorder(direction: 'up' | 'down') {
    const target = direction === 'up' ? up : down;
    if (target === null) return;
    // Which path ends up where shifts under a reorder — clear rather than
    // try to track the focused row through the splice.
    clearActiveAnchor();
    setVectorPaths(node.id, reorderPath(node.paths, index, target));
  }

  function handleDelete() {
    const result = deletePath(node.paths, index);
    clearActiveAnchor();
    if (result === null) {
      // Last path gone — the node has nothing left to rasterise or edit.
      // Full cleanup (cache + decoded source), same as LayerList's Trash2;
      // the Stack panel's stale-selection effect repairs the selection.
      deleteNode(node.id);
    } else {
      setVectorPaths(node.id, result);
    }
  }

  return (
    // Whole-row click focuses the path (LayerList's row-click convention);
    // the inner label button stays the keyboard-reachable target.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the inner button
    // biome-ignore lint/a11y/noStaticElementInteractions: same — pointer-only convenience
    <div
      onClick={onFocus}
      className={`flex items-center gap-2 rounded p-1 ${focused ? 'bg-neutral-800' : ''}`}
    >
      <button type="button" onClick={onFocus} className="flex-1 text-left min-w-0">
        <span className="min-w-0 truncate block text-xs" title={pathLabel(path, index)}>
          {pathLabel(path, index)}
        </span>
      </button>
      <button
        type="button"
        disabled={up === null}
        aria-label="Move path up"
        onClick={(e) => {
          e.stopPropagation();
          handleReorder('up');
        }}
      >
        ↑
      </button>
      <button
        type="button"
        disabled={down === null}
        aria-label="Move path down"
        onClick={(e) => {
          e.stopPropagation();
          handleReorder('down');
        }}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label="Delete path"
        className="text-neutral-500 hover:text-red-400"
        onClick={(e) => {
          e.stopPropagation();
          handleDelete();
        }}
      >
        <Icons.TrashIcon size={14} />
      </button>
    </div>
  );
}

export function VectorsPanel() {
  const nodes = useSceneStore((s) => s.scene.nodes);
  const selection = useSelectionStore((s) => s.selection);
  const setNodeProp = useSceneStore((s) => s.setNodeProp);
  const setVectorFillRule = useSceneStore((s) => s.setVectorFillRule);
  const activeAnchor = usePathEditStateStore((s) => s.activeAnchor);
  const setActiveAnchor = usePathEditStateStore((s) => s.setActiveAnchor);

  const selectedNodeId = selection.kind === 'node' ? selection.nodeId : null;
  const node = nodes.find((n) => n.id === selectedNodeId);

  if (!node || !isVectorNode(node)) {
    return (
      <div className="text-neutral-500 text-sm">
        Select a vector node to see and manage its paths.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm text-neutral-200">
      <div className="flex items-center justify-between gap-2 text-xs text-neutral-400">
        <span className="min-w-0 truncate font-medium text-neutral-200" title={node.label}>
          {node.label}
        </span>
        <span className="shrink-0">Vectors</span>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-neutral-400">Fill rule</span>
        <Select
          value={node.fillRule}
          items={FILL_RULE_ITEMS}
          onValueChange={(value) => {
            if (value) setVectorFillRule(node.id, value as VectorNode['fillRule']);
          }}
        >
          <SelectTrigger size="sm" className="h-6 w-fit text-xs" aria-label="Fill rule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILL_RULE_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value} className="text-xs">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-neutral-400">Output</span>
        <Select
          value={node.output}
          items={OUTPUT_ITEMS}
          onValueChange={(value) => {
            if (value) setNodeProp(node.id, { output: value as NodeOutput });
          }}
        >
          <SelectTrigger size="sm" className="h-6 w-fit text-xs" aria-label="Output">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTPUT_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value} className="text-xs">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1 border-t border-neutral-800 pt-3">
        {node.paths.length === 0 && (
          <div className="px-1 py-2 text-xs text-neutral-500">No paths.</div>
        )}
        {node.paths.map((path, index) => (
          <PathRow
            // biome-ignore lint/suspicious/noArrayIndexKey: paths carry no stable id (VectorPath has none); index is the story's own path-position identity, matches PathEditor's own pathIndex addressing.
            key={index}
            node={node}
            path={path}
            index={index}
            length={node.paths.length}
            focused={activeAnchor?.pathIndex === index}
            onFocus={() => setActiveAnchor({ pathIndex: index, anchorIndex: 0 })}
          />
        ))}
      </div>
    </div>
  );
}
