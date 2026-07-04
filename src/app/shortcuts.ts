import { useViewTransformStore } from '@/canvas/viewTransform';
import { exportPng } from '@/project/export';
import { openAnythingDialog, saveProject } from '@/project/io';

/**
 * Global keyboard shortcuts for the app shell.
 *
 * Cmd+0 -> fit document to window, Cmd+1 -> 100% zoom.
 * Cmd+O -> open dialog (routes .oblique project vs image by extension),
 * Cmd+S / Shift+Cmd+S -> save / save-as.
 * Shift+Cmd+E -> export PNG (mirrors the Shift+Cmd+<letter> "as"/variant
 * pattern already used by save-as).
 */
export function installShortcuts(): () => void {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!e.metaKey) return;

    // With Shift held, KeyboardEvent.key is the shifted character ('E' not
    // 'e') — normalise, or every Shift+Cmd+<letter> shortcut is dead.
    const key = e.key.toLowerCase();

    if (key === '0') {
      e.preventDefault();
      useViewTransformStore.getState().fitToWindow();
    } else if (key === '1') {
      e.preventDefault();
      useViewTransformStore.getState().reset100();
    } else if (key === 'o') {
      e.preventDefault();
      void openAnythingDialog();
    } else if (key === 's') {
      e.preventDefault();
      void saveProject({ as: e.shiftKey });
    } else if (key === 'e' && e.shiftKey) {
      e.preventDefault();
      void exportPng();
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
