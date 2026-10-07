import { type Binding, useCommands } from '@preset.nz/app-kit/core';
import { useMemo } from 'react';
import { useSnapStore } from '@/canvas/snapState';
import { useViewTransformStore } from '@/canvas/viewTransform';
import { convertSelectedTextToOutlines } from '@/fonts/convertToOutlines';
import { openExportProofDialog } from '@/panels/export/ExportProofDialog';
import { openReplaceFontDialog } from '@/panels/fonts/ReplaceFontDialog';
import { openSettingsDialog } from '@/panels/settings/SettingsDialog';
import { type LayerMove, layerMoveTarget } from '@/panels/stack/dragReorder';
import { exportPng } from '@/project/export';
import { tauriImportDeps } from '@/project/import';
import {
  importImagesDialog,
  newProject,
  openProjectDialog,
  replaceImageDialog,
  saveProject,
} from '@/project/io';
import { duplicateNode } from '@/scene/duplicateNode';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { commitActiveTextEdit } from '@/scene/textEditState';
import { isPixelNode } from '@/scene/types';

/**
 * What each menu command does: the webview half of app-kit's command table (Epic 22, slice b).
 *
 * The table itself is Rust's (`src-tauri/src/menu.rs`): ids, labels, accelerators and where each
 * sits in the bar. app-kit builds the native menu from it and sends every activation as a
 * `command` event carrying the id; `useCommands` finds the binding here and runs it when it is
 * enabled, and pushes the enabled and ticked state back to the menu. So this module is only
 * `id -> what it does`, plus the two items whose state follows the app: Replace Image… (enabled
 * while an unlocked image layer is selected) and Snap to Layers (a tick the snap store owns).
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
 * Open (Cmd+O) vs Import (Shift+Cmd+I): two distinct handlers, not one dialog routed by
 * extension. `openProjectDialog` replaces the whole project, `importImagesDialog` only ever adds
 * node(s).
 */

/**
 * Layer menu (drag-reorder.md): Bring Forward / Send Backward / Bring to Front /
 * Send to Back act on the selected node — the keyboard path for what the layer
 * grip does with the pointer. An open text edit commits first, like its
 * neighbours; no selection or the stack edge is a no-op (no store write, so no
 * undo step). Index 0 is the top of the stack.
 */
function moveSelectedLayer(move: LayerMove): void {
  commitActiveTextEdit();
  const selection = useSelectionStore.getState().selection;
  if (selection.kind !== 'node') return;
  const { nodes } = useSceneStore.getState().scene;
  const from = nodes.findIndex((n) => n.id === selection.nodeId);
  const to = layerMoveTarget(from, nodes.length, move);
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

/** The state the menu shows besides what the table says. */
export interface MenuState {
  /** An unlocked image layer is selected: Replace Image… is enabled. */
  replaceableImage: boolean;
  /** Snap to Layers is on: its tick. */
  snapToLayers: boolean;
}

/**
 * The command ids `menu.rs` declares, bound to what they do. An id the table doesn't have is
 * ignored by app-kit, and a command with no binding stays a dead menu item, which
 * `menu.test.ts` guards against.
 */
export function menuBindings(state: MenuState): Record<string, Binding> {
  const run = (f: () => unknown): Pick<Binding, 'run'> => ({ run: () => void f() });
  return {
    // App → Settings… (`app.settings`, app-kit's own item, Epic 17 story 1)
    'app.settings': run(openSettingsDialog),
    'file-new': run(newProject),
    'file-open': run(openProjectDialog),
    'file-import': run(importImagesDialog),
    'file-save': run(() => saveProject({ as: false })),
    'file-save-as': run(() => saveProject({ as: true })),
    'file-export-png': run(exportPng),
    // File → Export Proof… (registration-marks-and-colour-bars.md): opens the options dialog;
    // its Export… button runs `exportProof`. Plain Export PNG stays plain.
    'file-export-proof': run(openExportProofDialog),
    'edit-duplicate': run(duplicateSelected),
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
  };
}

/**
 * Binds the menu to the app: call once, from `App`. Follows the selection (Replace Image…) and
 * the snap store (the tick), and keeps text-field undo routed.
 */
export function useMenuCommands(): void {
  const selectedId = useSelectionStore((s) =>
    s.selection.kind === 'node' ? s.selection.nodeId : null,
  );
  const replaceableImage = useSceneStore((s) => {
    const node = s.scene.nodes.find((n) => n.id === selectedId);
    return node !== undefined && isPixelNode(node) && node.state !== 'locked';
  });
  const snapToLayers = useSnapStore((s) => s.enabled);
  const bindings = useMemo(
    () => menuBindings({ replaceableImage, snapToLayers }),
    [replaceableImage, snapToLayers],
  );
  useCommands(bindings);
}
