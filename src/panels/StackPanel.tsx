import { useEffect } from 'react';
// Side-effecting import: registers the shared package's built-in field
// renderers, Oblique's number/slider/select overrides, and the
// `modifier:<opType>` scopes (re-registered whenever the ops cache
// updates). See bootstrap.ts for the singleton rationale.
import './stack/bootstrap';
import { Lock } from 'lucide-react';
import { AddModifier } from '@/panels/stack/AddModifier';
import { LayerList } from '@/panels/stack/LayerList';
import { LOCKED_HINT, stackControlsDisabled } from '@/panels/stack/lockUi';
import { StackRow } from '@/panels/stack/StackRow';
import { toDisplayOrder } from '@/panels/stack/stackOrder';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { useOpsCacheStore } from '@/sidecar/opsCache';

/**
 * Real modifier stack panel (Epic 04 stack-rows) — replaces the Epic 02
 * debug panel entirely. `LayerList` picks the node; the modifier stack
 * below it displays bottom-to-top (epic README § "Stack direction
 * decision"): the scene-model `modifiers` array is unchanged application
 * order, `toDisplayOrder` just reverses it for rendering, and the
 * add-modifier button sits at the displayed top (= scene-model end).
 */
export function StackPanel() {
  const nodes = useSceneStore((s) => s.scene.nodes);
  const ops = useOpsCacheStore((s) => s.ops);
  const selection = useSelectionStore((s) => s.selection);
  const selectNode = useSelectionStore((s) => s.selectNode);

  useEffect(() => {
    // Only repair a selection that points at a DELETED node (fall back to
    // the top of the stack). `kind: 'none'` is a legitimate state — Escape
    // deselects and must stay deselected (dogfood 2026-07-05); never
    // auto-select out of it.
    if (selection.kind !== 'node') return;
    if (nodes.some((n) => n.id === selection.nodeId)) return;
    if (nodes[0]) selectNode(nodes[0].id);
  }, [nodes, selection, selectNode]);

  if (nodes.length === 0) {
    return <div className="text-neutral-500 text-sm">No layers yet — import an image.</div>;
  }

  const selectedNodeId = selection.kind === 'node' ? selection.nodeId : null;
  const node = nodes.find((n) => n.id === selectedNodeId);

  if (!node) {
    return (
      <div className="flex flex-col gap-3 text-sm text-neutral-200">
        <LayerList selectedNodeId={null} onSelectNode={selectNode} />
        <div className="border-t border-neutral-800 pt-3 text-xs text-neutral-500">
          No layer selected.
        </div>
      </div>
    );
  }

  const displayModifiers = toDisplayOrder(node.modifiers);
  const locked = stackControlsDisabled(node);

  return (
    <div className="flex flex-col gap-3 text-sm text-neutral-200">
      <LayerList selectedNodeId={node.id} onSelectNode={selectNode} />

      <div className="flex flex-col gap-1 border-t border-neutral-800 pt-3">
        <div className="mb-1 flex items-center justify-between gap-2 text-xs text-neutral-400">
          {/* min-w-0 + truncate: Draw Things exports put whole prompts in
              filenames; an untruncated label forces horizontal panel scroll. */}
          <span className="min-w-0 truncate font-medium text-neutral-200" title={node.label}>
            {node.label}
          </span>
          <span className="shrink-0">Stack</span>
        </div>

        {/* Inline hint (lock-ui.md) — beats per-control tooltips for
            explaining why every row below just went inert. */}
        {locked && (
          <div className="mb-1 flex items-center gap-1.5 rounded border border-amber-900/40 bg-amber-950/20 px-2 py-1 text-xs text-amber-400">
            <Lock size={12} />
            {LOCKED_HINT}
          </div>
        )}

        <AddModifier nodeId={node.id} ops={ops} disabled={locked} />

        {displayModifiers.length === 0 && (
          <div className="px-1 py-2 text-xs text-neutral-500">No modifiers yet.</div>
        )}

        {displayModifiers.map((modifier, displayIndex) => (
          <StackRow
            key={modifier.id}
            node={node}
            modifier={modifier}
            displayIndex={displayIndex}
            length={displayModifiers.length}
            ops={ops}
          />
        ))}
      </div>
    </div>
  );
}
