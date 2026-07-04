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

    if (e.key === '0') {
      e.preventDefault();
      useViewTransformStore.getState().fitToWindow();
    } else if (e.key === '1') {
      e.preventDefault();
      useViewTransformStore.getState().reset100();
    } else if (e.key === 'o') {
      e.preventDefault();
      void openAnythingDialog();
    } else if (e.key === 's') {
      e.preventDefault();
      void saveProject({ as: e.shiftKey });
    } else if (e.key === 'e' && e.shiftKey) {
      e.preventDefault();
      void exportPng();
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
