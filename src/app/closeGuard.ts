import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { PRODUCT_NAME } from '@/branding';
import { filenameOf } from '@/project/import';
import { useProjectMetaStore } from '@/project/io';

/**
 * Window-level project integration: the unsaved-changes close prompt and
 * the title (`name •` when dirty — project-persistence.md §Behaviour).
 * Installed once from App; both are no-ops outside a Tauri webview.
 */
export function installProjectWindowIntegration(): void {
  const win = getCurrentWindow();

  useProjectMetaStore.subscribe((state) => {
    const name = state.path ? filenameOf(state.path) : 'untitled';
    void win.setTitle(`${state.dirtySinceSave ? `${name} •` : name} — ${PRODUCT_NAME}`);
  });

  void win.onCloseRequested(async (event) => {
    if (!useProjectMetaStore.getState().dirtySinceSave) return;
    event.preventDefault();
    const leave = await confirm('You have unsaved changes. Close anyway?', {
      title: PRODUCT_NAME,
      kind: 'warning',
    });
    if (leave) await win.destroy();
  });
}
