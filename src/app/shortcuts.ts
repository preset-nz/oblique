import { useToolStateStore } from '@/canvas/toolState';

/**
 * Global keyboard shortcuts for the app shell.
 *
 * Cmd+0 (Fit in Window) and Opt+Cmd+0 (Actual Size, formerly Cmd+1) used to be handled
 * here; they are now View menu accelerators (view-menu-zoom.md), along with Zoom
 * In/Out (Cmd+=, Cmd+-), for the same NSMenu-consumes-the-key reason as below. Cmd+1 to
 * Cmd+9 are mode switches across the family and stay unbound until Oblique has modes.
 *
 * New/Open/Import/Save/Save As/Export PNG/Undo/Redo used to be handled here
 * too (Open was a combined Open-or-Import dialog before the roadmap
 * "Cmd+O is overloaded — split Open vs Import" split, 2026-07-05: Cmd+O is
 * now Open (projects only), Import (images only) was Cmd+I, now Shift+Cmd+I). As of
 * the native menu bar (`src-tauri/src/menu.rs` + `src/app/menu.ts`, roadmap
 * "Native app menu + New command") those accelerators are declared on the
 * menu items instead and have been removed from here — on macOS a menu
 * item's accelerator is a native key equivalent consumed by `NSMenu` before
 * the keydown reaches the webview, so a second handler here would be dead
 * code at best and a double-fire risk at worst if that assumption ever
 * proved wrong. See `src/app/menu.ts`'s doc comment for the reasoning and
 * the manual click-test that verifies it.
 *
 * `V`/`M`/`T` (tool-state.md, text-tool-and-inspector.md) are plain, unmodified keys — checked against every
 * existing accelerator in this file and `app/menu.ts` before wiring: all of
 * those are Cmd-based, so bare `v`/`m` are free. Guarded by the same
 * editable-target check as the Viewport nudge handler so typing in a text
 * field never re-tools the canvas underneath it.
 */
export function installShortcuts(): () => void {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Every Cmd-chord is a menu accelerator now; nothing here claims one.
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    const target = e.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return;
    }

    const key = e.key.toLowerCase();
    if (key === 'v') {
      e.preventDefault();
      useToolStateStore.getState().setTool('move');
    } else if (key === 'm') {
      e.preventDefault();
      useToolStateStore.getState().setTool('select-rect');
    } else if (key === 't') {
      e.preventDefault();
      useToolStateStore.getState().setTool('text');
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
