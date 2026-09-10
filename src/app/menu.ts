import { getCurrentWindow } from '@tauri-apps/api/window';
import { openSettingsDialog } from '@/panels/settings/SettingsDialog';
import { exportPng } from '@/project/export';
import { importImagesDialog, newProject, openProjectDialog, saveProject } from '@/project/io';
import { redo, undo } from '@/scene/history';

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
 * Shift+Cmd+E/Cmd+Z/Shift+Cmd+Z exclusively — `shortcuts.ts`'s keydown
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
const MENU_EVENTS: Record<string, () => void | Promise<void>> = {
  'menu://app/settings': () => openSettingsDialog(),
  'menu://file/new': () => newProject(),
  'menu://file/open': () => openProjectDialog(),
  'menu://file/import': () => importImagesDialog(),
  'menu://file/save': () => saveProject({ as: false }),
  'menu://file/save-as': () => saveProject({ as: true }),
  'menu://file/export-png': () => exportPng(),
  'menu://edit/undo': () => undo(),
  'menu://edit/redo': () => redo(),
};

/** Installs all menu-event listeners; returns a teardown that unlistens everything. */
export function installMenu(): () => void {
  const win = getCurrentWindow();
  let disposed = false;
  const unlistens: Array<() => void> = [];

  for (const [event, handler] of Object.entries(MENU_EVENTS)) {
    win
      .listen(event, () => void handler())
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
