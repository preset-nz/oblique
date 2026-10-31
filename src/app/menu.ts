import { type Binding, useCommands } from '@preset.nz/app-kit/core';
import { useModelGate } from '@preset.nz/app-kit/models';
import { useMemo } from 'react';
import {
  canCreateDepthMap,
  createDepthMap,
  productionCreateDepthMapDeps,
} from '@/ai/createDepthMap';
import { usePanelStore } from '@/app/panelState';
import { useColourSelectStore } from '@/canvas/colourSelect/state';
import { useSelectionFillStore } from '@/canvas/selectionFillState';
import { useSmartSelectStore } from '@/canvas/smartSelect/state';
import { useSnapStore } from '@/canvas/snapState';
import { useToolStateStore } from '@/canvas/toolState';
import { useViewTransformStore } from '@/canvas/viewTransform';
import { convertSelectedTextToOutlines } from '@/fonts/convertToOutlines';
import { openDocumentSettingsDialog } from '@/panels/document/DocumentSettingsDialog';
import { openExportProofDialog } from '@/panels/export/ExportProofDialog';
import { openReplaceFontDialog } from '@/panels/fonts/ReplaceFontDialog';
import { openSettingsDialog } from '@/panels/settings/SettingsDialog';
import { type LayerMove, layerMoveRealIndex } from '@/panels/stack/dragReorder';
import { exportPng } from '@/project/export';
import { tauriImportDeps } from '@/project/import';
import { importImagesDialog, replaceImageDialog } from '@/project/io';
import { useActiveSelectionStore } from '@/scene/activeSelection';
import { duplicateNode } from '@/scene/duplicateNode';
import { isMaskableMarquee, useMarqueeStateStore } from '@/scene/marquee';
import { saveActiveSelection } from '@/scene/saveSelection';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { commitActiveTextEdit } from '@/scene/textEditState';
import { isPixelNode } from '@/scene/types';
import { useSidecarStatusStore } from '@/sidecar/client';

/**
 * What each menu command does: the webview half of app-kit's command table (Epic 22, slice b).
 *
 * The table itself is Rust's (`src-tauri/src/menu.rs`): ids, labels, accelerators and where each
 * sits in the bar. app-kit builds the native menu from it and sends every activation as a
 * `command` event carrying the id; `useCommands` finds the binding here and runs it when it is
 * enabled, and pushes the enabled and ticked state back to the menu. So this module is only
 * `id -> what it does`, plus the items whose state follows the app: Replace Image… (enabled
 * while an unlocked image layer is selected), Save Selection (enabled while a finished marquee
 * is up), Deselect (enabled while a marquee or an active selection is up) and the View ticks: Snap to Layers (the snap store's),
 * Show Selection Fill (the selection fill store's) and the two side panels (`app/panelState.ts`).
 *
 * **Undo and Redo are not here.** They are app-kit's own Edit items, running the document host's
 * history in Rust; the host tells the webview with `history-stepped` and `rhizome/rhizome.ts`
 * rebuilds the store from the mirror. While a text field has focus, app-kit sends `text-undo`
 * instead and the field undoes its own typing (see `scene/textEditState.ts`).
 *
 * A menu accelerator is a native key equivalent consumed by `NSMenu` before the key reaches the
 * webview, so the menu owns every chord in `menu.rs`'s `SHORTCUTS` and `shortcuts.ts` claims none
 * of them. That is the mainstream behaviour but can't be exercised headlessly: click-test it.
 *
 * **File's New, Open…, Open Recent, Close, Save, Save As… and Revert are not here either:** app-kit
 * runs them in Rust against the document host, and the webview hears of the result
 * (`project/io.ts`, `projectDocumentEvents`). Open replaces the whole project; Import
 * (Shift+Cmd+I, below) only ever adds node(s).
 */

/**
 * Layer menu (drag-reorder.md): Bring Forward / Send Backward / Bring to Front /
 * Send to Back act on the selected node — the keyboard path for what the layer
 * grip does with the pointer. An open text edit commits first, like its
 * neighbours; no selection or the stack edge is a no-op (no store write, so no
 * undo step). Index 0 is the top of the stack; saved selections are skipped (selections-panel.md).
 */
function moveSelectedLayer(move: LayerMove): void {
  commitActiveTextEdit();
  const selection = useSelectionStore.getState().selection;
  if (selection.kind !== 'node') return;
  const { nodes } = useSceneStore.getState().scene;
  // Counted among the layers the list shows: a saved selection (selected after Edit Shape) is
  // not in the layer order, so it is a no-op, and a layer never stops on one.
  const to = layerMoveRealIndex(nodes, selection.nodeId, move);
  if (to === null) return;
  useSceneStore.getState().reorderNode(selection.nodeId, to);
}

/**
 * The selected node when it is an image (pixel) layer that isn't locked — what
 * Layer → Replace Image… acts on. Also decides whether the item is enabled.
 */
function selectedReplaceableImage(): string | null {
  const selection = useSelectionStore.getState().selection;
  if (selection.kind !== 'node') return null;
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === selection.nodeId);
  return node && isPixelNode(node) && node.state !== 'locked' ? node.id : null;
}

/** Layer → Replace Image… (image-source.md): the same flow as the Image section's Browse…. */
async function replaceSelectedImage(): Promise<void> {
  commitActiveTextEdit();
  const nodeId = selectedReplaceableImage();
  if (nodeId) await replaceImageDialog(nodeId);
}

/** Edit → Duplicate (duplicate-node.md): the copy becomes the selection, so a second one duplicates the copy. */
async function duplicateSelected(): Promise<void> {
  commitActiveTextEdit();
  const selection = useSelectionStore.getState().selection;
  if (selection.kind !== 'node') return;
  const newId = await duplicateNode(selection.nodeId, tauriImportDeps);
  if (newId) useSelectionStore.getState().selectNode(newId);
}

/**
 * Select > Deselect: drops the live marquee and the active selection. Smart and Colour Select's
 * prompt markers follow the marquee's clearing through their controllers, as they do for Return.
 */
export function deselect(): void {
  useMarqueeStateStore.getState().clear();
  useActiveSelectionStore.getState().clear();
  // As Escape does: the armed selection tool's own prompt goes with the marquee.
  const tool = useToolStateStore.getState().tool;
  if (tool === 'select-smart') useSmartSelectStore.getState().clearPrompt();
  if (tool === 'select-colour') useColourSelectStore.getState().clearPrompt();
}

/** Layer → Create Depth Map (Epic 17 story 5): the selected layer, through the ask-first gate. */
function createDepthMapOfSelection(ensure: MenuDeps['ensure']): void {
  commitActiveTextEdit();
  const selection = useSelectionStore.getState().selection;
  if (selection.kind !== 'node') return;
  void createDepthMap(selection.nodeId, 8, productionCreateDepthMapDeps(ensure));
}

/** What the bindings need that isn't plain state: the model gate, which is a hook (`useModelGate`). */
export interface MenuDeps {
  ensure: (id: string, options?: { for?: string }) => Promise<void>;
}

/** Without the hook's gate (the bindings' own tests), a command that needs a model fails loudly. */
const NO_MODEL_GATE: MenuDeps = {
  ensure: () => Promise.reject(new Error('the model gate is not mounted')),
};

/** The state the menu shows besides what the table says. */
export interface MenuState {
  /** A layer that cooks is selected and the sidecar is up: Create Depth Map is enabled. */
  depthSource: boolean;
  /** An unlocked image layer is selected: Replace Image… is enabled. */
  replaceableImage: boolean;
  /** A finished marquee is up: Select > Save Selection is enabled. */
  savableSelection: boolean;
  /** A marquee or an active selection is up: Select > Deselect is enabled. */
  deselectable: boolean;
  /** Snap to Layers is on: its tick. */
  snapToLayers: boolean;
  /** Show Selection Fill is on: its tick. */
  selectionFill: boolean;
  /** The left panel (tool rail) is showing: its tick. */
  leftPanel: boolean;
  /** The right panel (tabbed side panel) is showing: its tick. */
  rightPanel: boolean;
}

/**
 * The command ids `menu.rs` declares, bound to what they do. An id the table doesn't have is
 * ignored by app-kit, and a command with no binding stays a dead menu item, which
 * `menu.test.ts` guards against.
 */
export function menuBindings(
  state: MenuState,
  deps: MenuDeps = NO_MODEL_GATE,
): Record<string, Binding> {
  const run = (f: () => unknown): Pick<Binding, 'run'> => ({ run: () => void f() });
  return {
    // App → Settings… (`app.settings`, app-kit's own item, Epic 17 story 1)
    'app.settings': run(openSettingsDialog),
    'file-import': run(importImagesDialog),
    // File → Document Settings… (Epic 22 slice d): the only place the document's fields show. An open text edit commits first, as its neighbours do: the size change is its
    // own undo step.
    'file-document-settings': {
      run: () => {
        commitActiveTextEdit();
        openDocumentSettingsDialog();
      },
    },
    'file-export-png': run(exportPng),
    // File → Export Proof… (registration-marks-and-colour-bars.md): opens the options dialog;
    // its Export… button runs `exportProof`. Plain Export PNG stays plain.
    'file-export-proof': run(openExportProofDialog),
    'edit-duplicate': run(duplicateSelected),
    // View → Show Left / Right Panel (menu standard decision 14): view state, not an undo step.
    // As with Snap to Layers, the store is the truth and the tick follows it.
    'view-left-panel': {
      pressed: state.leftPanel,
      run: () => usePanelStore.getState().toggleLeft(),
    },
    'view-right-panel': {
      pressed: state.rightPanel,
      run: () => usePanelStore.getState().toggleRight(),
    },
    // View menu (view-menu-zoom.md): the same store actions the status-bar buttons call.
    'view-zoom-in': run(() => useViewTransformStore.getState().zoomIn()),
    'view-zoom-out': run(() => useViewTransformStore.getState().zoomOut()),
    'view-fit': run(() => useViewTransformStore.getState().fitToWindow()),
    'view-actual': run(() => useViewTransformStore.getState().reset100()),
    // View → Snap to Layers (snapping.md): the snap store is the truth and the menu follows it
    // (`pressed`); muda has already flipped the tick by the time this runs, and the state
    // pushed back after the flip agrees with it.
    'view-snap-layers': {
      pressed: state.snapToLayers,
      run: () => useSnapStore.getState().setEnabled(!useSnapStore.getState().enabled),
    },
    // View → Show Selection Fill (selection-fill-overlay.md): the same shape as Snap to Layers.
    // View state, so not an undo step and it doesn't dirty the document.
    'view-selection-fill': {
      pressed: state.selectionFill,
      run: () =>
        useSelectionFillStore.getState().setEnabled(!useSelectionFillStore.getState().enabled),
    },
    // Layer menu (drag-reorder.md)
    'layer-forward': run(() => moveSelectedLayer('forward')),
    'layer-backward': run(() => moveSelectedLayer('backward')),
    'layer-front': run(() => moveSelectedLayer('front')),
    'layer-back': run(() => moveSelectedLayer('back')),
    // Layer → Replace Image… (image-source.md): enabled only for an unlocked pixel node.
    'layer-replace-image': {
      enabled: state.replaceableImage,
      run: () => void replaceSelectedImage(),
    },
    // Layer → Create Depth Map (Epic 17 story 5): a new layer above the selected one, one undo
    // step, 8-bit. 16-bit waits for the `data` layer type (see `createDepthMap`).
    'layer-create-depth-map': {
      enabled: state.depthSource,
      run: () => createDepthMapOfSelection(deps.ensure),
    },
    // Type menu (Epic 20): a Replace Font undo step must not swallow a half-finished text edit,
    // and the outline conversion is its own undo step, so an open edit commits first in both.
    'type-replace-font': {
      run: () => {
        commitActiveTextEdit();
        openReplaceFontDialog();
      },
    },
    'type-convert-outlines': {
      run: () => {
        commitActiveTextEdit();
        void convertSelectedTextToOutlines();
      },
    },
    // Select menu (Epic 26): Return on the canvas is the key (`Viewport.tsx`), so no chord here.
    // Enabled only while a maskable marquee is active; an open text edit commits first, as its
    // neighbours do, so the selection is its own undo step.
    'select-save': {
      enabled: state.savableSelection,
      run: () => {
        commitActiveTextEdit();
        saveActiveSelection();
      },
    },
    // Select > Deselect (selections-panel.md): what Escape clears on the canvas, the marquee and
    // the active selection (not the node selection), here for the menu. No chord: Cmd+D is
    // Duplicate. View state, so not an undo step.
    'select-deselect': {
      enabled: state.deselectable,
      run: deselect,
    },
  };
}

/**
 * Binds the menu to the app: call once, from `App`. Follows the selection (Replace Image…), the
 * snap, selection fill and panel stores (the ticks), and keeps text-field undo routed.
 */
export function useMenuCommands(): void {
  const selectedId = useSelectionStore((s) =>
    s.selection.kind === 'node' ? s.selection.nodeId : null,
  );
  const replaceableImage = useSceneStore((s) => {
    const node = s.scene.nodes.find((n) => n.id === selectedId);
    return node !== undefined && isPixelNode(node) && node.state !== 'locked';
  });
  const sidecarUp = useSidecarStatusStore((s) => s.status === 'up');
  const depthSource = useSceneStore(
    (s) => sidecarUp && canCreateDepthMap(s.scene.nodes.find((n) => n.id === selectedId)),
  );
  const { ensure } = useModelGate();
  const savableSelection = useMarqueeStateStore((s) => isMaskableMarquee(s.marquee));
  const deselectable = useMarqueeStateStore((s) => s.marquee !== null);
  const hasActiveSelection = useActiveSelectionStore((s) => s.id !== null);
  const snapToLayers = useSnapStore((s) => s.enabled);
  const selectionFill = useSelectionFillStore((s) => s.enabled);
  const leftPanel = usePanelStore((s) => s.left);
  const rightPanel = usePanelStore((s) => s.right);
  const bindings = useMemo(
    () =>
      menuBindings(
        {
          depthSource,
          replaceableImage,
          savableSelection,
          deselectable: deselectable || hasActiveSelection,
          snapToLayers,
          selectionFill,
          leftPanel,
          rightPanel,
        },
        { ensure },
      ),
    [
      depthSource,
      ensure,
      replaceableImage,
      savableSelection,
      deselectable,
      hasActiveSelection,
      snapToLayers,
      selectionFill,
      leftPanel,
      rightPanel,
    ],
  );
  useCommands(bindings);
}
