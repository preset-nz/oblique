import { useViewTransformStore } from '@/canvas/viewTransform';

/**
 * Global keyboard shortcuts for the app shell.
 *
 * Cmd+0 -> fit document to window, Cmd+1 -> 100% zoom. These have no menu
 * item (view-only, no natural File/Edit home), so they stay here.
 *
 * New/Open/Save/Save As/Export PNG/Undo/Redo used to be handled here too.
 * As of the native menu bar (`src-tauri/src/menu.rs` + `src/app/menu.ts`,
 * roadmap "Native app menu + New command") those accelerators are declared
 * on the menu items instead and have been removed from here — on macOS a
 * menu item's accelerator is a native key equivalent consumed by `NSMenu`
 * before the keydown reaches the webview, so a second handler here would
 * be dead code at best and a double-fire risk at worst if that assumption
 * ever proved wrong. See `src/app/menu.ts`'s doc comment for the reasoning
 * and the manual click-test that verifies it.
 */
export function installShortcuts(): () => void {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!e.metaKey) return;

    const key = e.key.toLowerCase();

    if (key === '0') {
      e.preventDefault();
      useViewTransformStore.getState().fitToWindow();
    } else if (key === '1') {
      e.preventDefault();
      useViewTransformStore.getState().reset100();
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
