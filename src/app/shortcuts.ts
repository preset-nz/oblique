import { useViewTransformStore } from '@/canvas/viewTransform';
import { openImportDialog } from '@/project/import';

/**
 * Global keyboard shortcuts for the app shell.
 *
 * Cmd+0 -> fit document to window, Cmd+1 -> 100% zoom, Cmd+O -> file-open
 * dialog (pixel node import).
 * Project persistence (Epic 02+) will extend this with more shortcuts.
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
      void openImportDialog();
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
