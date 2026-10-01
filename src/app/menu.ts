import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSnapStore } from '@/canvas/snapState';
import { useViewTransformStore } from '@/canvas/viewTransform';
import { convertSelectedTextToOutlines } from '@/fonts/convertToOutlines';
import { openReplaceFontDialog } from '@/panels/fonts/ReplaceFontDialog';
import { openSettingsDialog } from '@/panels/settings/SettingsDialog';
import { type LayerMove, layerMoveTarget } from '@/panels/stack/dragReorder';
import { exportPng } from '@/project/export';
import { tauriImportDeps } from '@/project/import';
import { importImagesDialog, newProject, openProjectDialog, saveProject } from '@/project/io';
import { duplicateNode } from '@/scene/duplicateNode';
import { redo, undo } from '@/scene/history';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { commitActiveTextEdit } from '@/scene/textEditState';

/**
 * Native macOS menu bar → webview bridge (roadmap gap "Native app menu +
 * New command", 2026-07-04). The Rust side (`src-tauri/src/menu.rs`) builds
 * the App/File/Edit menu and forwards item activation as plain Tauri
 * events; this module just listens and reuses the exact same handlers
 * `shortcuts.ts` calls for the keyboard paths, so there is one behaviour
 * per command, not two.
 *
 * Double-firing: on macOS, a menu item's accelerator is a native key
 * equivalent consumed by `NSMenu`/`performKeyEquivalent:` before the
 * keydown reaches the WKWebView, so the menu owns Cmd+,/N/O/I/S/Shift+Cmd+S/
 * Shift+Cmd+E/Cmd+Z/Shift+Cmd+Z and the View zoom accelerators
 * (Cmd+=/Cmd+-/Cmd+0/Cmd+1, view-menu-zoom.md), View → Snap to Layers
 * (Cmd+;, snapping.md — a check item, see its handler below) and the Layer menu's
 * Cmd+]/Cmd+[ (+Shift, drag-reorder.md) exclusively — `shortcuts.ts`'s keydown
 * branches for those keys were removed rather than kept as dead/duplicate
 * paths (this is the mainstream, expected behaviour, but wasn't
 * exercisable headlessly in this environment — see the story report for
 * the manual click-test to confirm no double-fire). Cmd+, (Settings…,
 * Epic 17 story 1) never had a `shortcuts.ts` branch to remove — the menu
 * is its only source.
 *
 * Open (Cmd+O) vs Import (Cmd+I) (roadmap "Cmd+O is overloaded — split Open
 * vs Import", 2026-07-05): two distinct handlers, not one dialog routed by
 * extension — `openProjectDialog` replaces the whole project,
 * `importImagesDialog` only ever adds node(s).
 *
 * Listens via `getCurrentWindow().listen(...)` rather than the top-level
 * `@tauri-apps/api/event` `listen` — same wire event, but this keeps
 * `menu.ts` outside the `tauri-frame-ipc-only-via-sidecar-transport`
 * dependency-cruiser gate (architecture.md: nobody but the sidecar frame
 * transport touches `@tauri-apps/api/(core|event)` directly). The Rust
 * side's `app.emit(...)` is an unfiltered broadcast (`EventTarget::any()`
 * semantics — Tauri's own docs: "emits ... to all webviews"), so a
 * window-scoped listener receives it exactly the same as the top-level one
 * would.
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

const MENU_EVENTS: Record<string, (payload: unknown) => void | Promise<void>> = {
  'menu://app/settings': () => openSettingsDialog(),
  'menu://file/new': () => newProject(),
  'menu://file/open': () => openProjectDialog(),
  'menu://file/import': () => importImagesDialog(),
  'menu://file/save': () => saveProject({ as: false }),
  'menu://file/save-as': () => saveProject({ as: true }),
  'menu://file/export-png': () => exportPng(),
  // The native menu owns Cmd+Z even while the inspector's Text field has
  // focus, so an open text edit (an open history transaction) must be
  // committed first — otherwise undo() would flush a half-finished edit or
  // leave a new blank node orphaned (text-tool-and-inspector.md).
  'menu://edit/undo': () => {
    commitActiveTextEdit();
    return undo();
  },
  'menu://edit/redo': () => {
    commitActiveTextEdit();
    return redo();
  },
  // Edit → Duplicate (Cmd+D, duplicate-node.md): an open text edit commits
  // first; the copy becomes the selection so a second Cmd+D duplicates the copy.
  'menu://edit/duplicate': async () => {
    commitActiveTextEdit();
    const selection = useSelectionStore.getState().selection;
    if (selection.kind !== 'node') return;
    const newId = await duplicateNode(selection.nodeId, tauriImportDeps);
    if (newId) useSelectionStore.getState().selectNode(newId);
  },
  // View menu (view-menu-zoom.md): the same store actions the status-bar
  // buttons call. Cmd+0/Cmd+1 used to be keydown branches in shortcuts.ts.
  'menu://view/zoom-in': () => useViewTransformStore.getState().zoomIn(),
  'menu://view/zoom-out': () => useViewTransformStore.getState().zoomOut(),
  'menu://view/fit': () => useViewTransformStore.getState().fitToWindow(),
  'menu://view/actual-size': () => useViewTransformStore.getState().reset100(),
  // View -> Snap to Layers (snapping.md, Cmd+;). A native check item: muda
  // toggles it on click and menu.rs sends the NEW checked state as the payload,
  // so the menu stays the source of truth and the store only mirrors it (no
  // invoke back to Rust to set the tick; both default to on).
  'menu://view/snap-to-layers': (payload) => useSnapStore.getState().setEnabled(payload === true),
  // Layer menu (drag-reorder.md): Cmd+] / Cmd+[ and the Shift variants.
  'menu://layer/forward': () => moveSelectedLayer('forward'),
  'menu://layer/backward': () => moveSelectedLayer('backward'),
  'menu://layer/front': () => moveSelectedLayer('front'),
  'menu://layer/back': () => moveSelectedLayer('back'),
  // Same reason: Replace's undo step must not swallow a half-finished text edit.
  'menu://type/replace-font': () => {
    commitActiveTextEdit();
    openReplaceFontDialog();
  },
  // Same again: the conversion is its own undo step, so an open edit commits first.
  'menu://type/convert-outlines': () => {
    commitActiveTextEdit();
    return convertSelectedTextToOutlines();
  },
};

/** Installs all menu-event listeners; returns a teardown that unlistens everything. */
export function installMenu(): () => void {
  const win = getCurrentWindow();
  let disposed = false;
  const unlistens: Array<() => void> = [];

  for (const [event, handler] of Object.entries(MENU_EVENTS)) {
    win
      .listen(event, (e) => void handler(e.payload))
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlistens.push(fn);
        }
      });
  }

  return () => {
    disposed = true;
    for (const fn of unlistens) fn();
  };
}
