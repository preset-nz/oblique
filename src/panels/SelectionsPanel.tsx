import { Icons, Tooltip, TooltipContent, TooltipTrigger } from '@preset.nz/ux-kit';
import { useActiveSelectionStore } from '@/scene/activeSelection';
import { deleteNode } from '@/scene/deleteNode';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { isSelectionNode, type Scene, type VectorNode } from '@/scene/types';
import { useNodeRename } from './stack/nodeRename';

/**
 * Selections tab (selections-panel.md): the saved selections, one row each, in stack order. A
 * row is the selection as a thing you pick, not its paths: click makes it the active selection
 * (its tint and outline show on the canvas in every tool), click again clears it, double-click
 * or F2 renames, the pencil is Edit Shape and the trash deletes the node. The Vectors tab stays
 * the path-level view.
 *
 * Panel-scoped: imports nothing from `src/canvas/`. The active selection is
 * `scene/activeSelection.ts`; Edit Shape asks the canvas for the Move tool through that store's
 * `requestShapeEdit`.
 */

/** The saved selections, in stack order. */
export function selectionNodes(scene: Pick<Scene, 'nodes'>): VectorNode[] {
  return scene.nodes.filter(isSelectionNode);
}

/**
 * How many modifiers a selection masks: every modifier, on any layer, whose mask reference
 * points at the node. Counted per modifier, so one selection on two blurs reads "2 effects".
 */
export function effectsCount(
  scene: Pick<Scene, 'nodes' | 'maskRefs'>,
  selectionId: string,
): number {
  let count = 0;
  for (const node of scene.nodes) {
    for (const modifier of node.modifiers) {
      if (modifier.maskId && scene.maskRefs?.[modifier.maskId]?.nodeId === selectionId) count++;
    }
  }
  return count;
}

/** "1 effect" / "2 effects"; empty when the selection masks nothing. */
export function effectsLabel(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 effect' : `${count} effects`;
}

/** A row click: activates the selection, or clears it when it is already the active one. */
export function toggleActiveSelection(id: string): void {
  const store = useActiveSelectionStore.getState();
  if (store.id === id) store.clear();
  else store.activate(id);
}

/**
 * Edit Shape: selects the node and makes it the active selection, then asks for the Move tool,
 * where the path editor draws the selected vector node's anchors.
 */
export function editSelectionShape(id: string): void {
  useSelectionStore.getState().selectNode(id);
  useActiveSelectionStore.getState().activate(id);
  useActiveSelectionStore.getState().requestShapeEdit();
}

function SelectionRow({
  node,
  active,
  effects,
}: {
  node: VectorNode;
  active: boolean;
  effects: number;
}) {
  const rename = useNodeRename(node, 'Selection name');
  const effectsText = effectsLabel(effects);

  return (
    // The whole row picks it (the layer list's convention); the label button is the keyboard
    // path and every inner control stops its own click.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the inner button
    // biome-ignore lint/a11y/noStaticElementInteractions: same — pointer-only convenience
    <div
      onClick={() => toggleActiveSelection(node.id)}
      data-active={active ? '' : undefined}
      className={`flex cursor-pointer items-center gap-2 rounded p-1 ${active ? 'bg-neutral-800' : ''}`}
    >
      {rename.editing ? (
        rename.input
      ) : (
        <button
          type="button"
          aria-pressed={active}
          onClick={(e) => {
            e.stopPropagation();
            toggleActiveSelection(node.id);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            rename.start();
          }}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault();
              rename.start();
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icons.SelectionIcon
            size={14}
            className={`shrink-0 ${active ? 'text-sky-400' : 'text-neutral-500'}`}
          />
          <span className="min-w-0 flex-1 truncate text-xs" title={node.label}>
            {node.label}
          </span>
        </button>
      )}
      {effectsText && <span className="shrink-0 text-xs text-neutral-500">{effectsText}</span>}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Edit shape"
              className="shrink-0 text-neutral-500 hover:text-neutral-200"
              onClick={(e) => {
                e.stopPropagation();
                editSelectionShape(node.id);
              }}
            />
          }
        >
          <Icons.PencilSimpleIcon size={14} />
        </TooltipTrigger>
        <TooltipContent>Edit shape</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Delete selection"
              className="shrink-0 text-neutral-500 hover:text-red-400"
              onClick={(e) => {
                e.stopPropagation();
                deleteNode(node.id);
              }}
            />
          }
        >
          <Icons.TrashIcon size={14} />
        </TooltipTrigger>
        <TooltipContent>Delete selection</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function SelectionsPanel() {
  const scene = useSceneStore((s) => s.scene);
  const activeId = useActiveSelectionStore((s) => s.id);
  const selections = selectionNodes(scene);

  if (selections.length === 0) {
    return (
      <div className="text-sm text-neutral-500">
        Saved selections show here. Make a selection and press Return.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-selection-list="">
      {selections.map((node) => (
        <SelectionRow
          key={node.id}
          node={node}
          active={node.id === activeId}
          effects={effectsCount(scene, node.id)}
        />
      ))}
    </div>
  );
}
