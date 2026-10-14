import { useEffect, useRef } from 'react';
// Side-effecting import: registers the shared package's built-in field
// renderers, Oblique's number/slider/select overrides, and the
// `modifier:<opType>` scopes (re-registered whenever the ops cache
// updates). See bootstrap.ts for the singleton rationale.
import './stack/bootstrap';
import { Icons } from '@preset.nz/ux-kit';
import { ImageInspector } from '@/panels/image/ImageInspector';
import { AddModifier } from '@/panels/stack/AddModifier';
import { LayerList } from '@/panels/stack/LayerList';
import { LOCKED_HINT, stackControlsDisabled } from '@/panels/stack/lockUi';
import { StackRow } from '@/panels/stack/StackRow';
import { invertIndex, toDisplayOrder } from '@/panels/stack/stackOrder';
import { useDragReorder } from '@/panels/stack/useDragReorder';
import { TextInspector } from '@/panels/text/TextInspector';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { isPixelNode, isTextNode } from '@/scene/types';
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
  const categories = useOpsCacheStore((s) => s.categories);
  const selection = useSelectionStore((s) => s.selection);
  const selectNode = useSelectionStore((s) => s.selectNode);
  const reorderModifier = useSceneStore((s) => s.reorderModifier);
  const modifierListRef = useRef<HTMLDivElement>(null);
  const selectedNode =
    selection.kind === 'node' ? nodes.find((n) => n.id === selection.nodeId) : undefined;
  // The rows are in display order (reversed); the drag works in display
  // indices, so convert the drop target back with invertIndex before the
  // store call, which operates on the application-order model array.
  const { draggingIndex, indicatorTop, gripProps } = useDragReorder({
    containerRef: modifierListRef,
    onCommit: (fromDisplay, toDisplay) => {
      if (!selectedNode) return;
      const modifier = toDisplayOrder(selectedNode.modifiers)[fromDisplay];
      if (!modifier) return;
      reorderModifier(
        selectedNode.id,
        modifier.id,
        invertIndex(toDisplay, selectedNode.modifiers.length),
      );
    },
  });

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
    return (
      <div className="flex flex-col gap-3 text-sm text-neutral-200">
        <div className="text-neutral-500">No layers yet — import an image.</div>
      </div>
    );
  }

  const selectedNodeId = selection.kind === 'node' ? selection.nodeId : null;
  const node = nodes.find((n) => n.id === selectedNodeId);

  if (!node) {
    return (
      <div className="flex flex-col gap-3 text-sm text-neutral-200">
        <LayerList selectedNodeId={null} onSelectNode={selectNode} />
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
            <Icons.LockIcon size={12} />
            {LOCKED_HINT}
          </div>
        )}

        {isPixelNode(node) && <ImageInspector node={node} />}
        {isTextNode(node) && <TextInspector node={node} />}

        <AddModifier nodeId={node.id} ops={ops} categories={categories} disabled={locked} />

        {displayModifiers.length === 0 && (
          <div className="px-1 py-2 text-xs text-neutral-500">No modifiers yet.</div>
        )}

        <div ref={modifierListRef} className="relative flex flex-col gap-1">
          {displayModifiers.map((modifier, displayIndex) => (
            <StackRow
              key={modifier.id}
              node={node}
              modifier={modifier}
              displayIndex={displayIndex}
              dragging={draggingIndex === displayIndex}
              gripProps={gripProps}
              ops={ops}
            />
          ))}
          {indicatorTop !== null && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 h-0.5 -translate-y-1/2 rounded bg-sky-500"
              style={{ top: indicatorTop }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
