import { confirm, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import { create } from 'zustand';
import { PRODUCT_NAME } from '@/branding';
import * as cache from '@/scene/cache';
import * as history from '@/scene/history';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import { isPixelNode } from '@/scene/types';
import { filenameOf, importFiles, tauriImportDeps } from './import';

export const PROJECT_FORMAT = 'oblique-project';
export const PROJECT_VERSION = 1;

/**
 * Current project file + unsaved-changes flag. Transient app state, never
 * persisted; the window title and status bar mirror it.
 */
interface ProjectMetaState {
  path: string | null;
  dirtySinceSave: boolean;
  setPath: (path: string | null) => void;
  markSaved: () => void;
  markMutated: () => void;
}

export const useProjectMetaStore = create<ProjectMetaState>((set) => ({
  path: null,
  dirtySinceSave: false,
  setPath: (path) => set({ path }),
  markSaved: () => set({ dirtySinceSave: false }),
  markMutated: () => set({ dirtySinceSave: true }),
}));

/** Serialise the scene to the on-disk project JSON (format doc: project-persistence.md). */
export function serialiseProject(scene: Scene): string {
  return JSON.stringify(
    { format: PROJECT_FORMAT, version: PROJECT_VERSION, saved: new Date().toISOString(), scene },
    null,
    2,
  );
}

/** Parse + validate project JSON. Throws with a user-showable message; never half-loads. */
export function parseProject(text: string): Scene {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const record = doc as Record<string, unknown>;
  if (record?.format !== PROJECT_FORMAT) {
    throw new Error('not an Oblique project file');
  }
  if (record.version !== PROJECT_VERSION) {
    throw new Error(`unsupported project version ${String(record.version)} (expected 1)`);
  }
  if (typeof record.scene !== 'object' || record.scene === null) {
    throw new Error('project file has no scene');
  }
  return record.scene as Scene;
}

/**
 * File-system edges injected for tests (same pattern as `ImportDeps`);
 * decode is the pixel-source re-hydration path shared with import.
 */
export interface ProjectIoDeps {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number } & sources.Closable>;
}

export const tauriProjectIoDeps: ProjectIoDeps = {
  readTextFile,
  writeTextFile,
  rename,
  readFile: tauriImportDeps.readFile,
  decode: tauriImportDeps.decode,
};

/**
 * Atomic write: temp file in the same directory, then rename over the
 * target — a crash mid-write can never destroy the previous save.
 */
export async function writeProjectFile(
  path: string,
  scene: Scene,
  deps: ProjectIoDeps,
): Promise<void> {
  const tmp = `${path}.tmp-${Date.now()}`;
  await deps.writeTextFile(tmp, serialiseProject(scene));
  await deps.rename(tmp, path);
}

/** Save to the current path, or run save-as when there is none (or `as` forces it). */
export async function saveProject(
  options: { as?: boolean } = {},
  deps: ProjectIoDeps = tauriProjectIoDeps,
): Promise<void> {
  const meta = useProjectMetaStore.getState();
  let path = options.as ? null : meta.path;
  if (!path) {
    const picked = await saveDialog({
      filters: [{ name: 'Oblique project', extensions: ['oblique'] }],
    });
    if (!picked) return;
    path = picked;
  }
  try {
    await writeProjectFile(path, useSceneStore.getState().scene, deps);
    meta.setPath(path);
    meta.markSaved();
  } catch (err) {
    toast.error("Couldn't save project", {
      description: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Load a `.oblique` file: validate, swap the scene in verbatim, re-decode
 * every pixel source (missing file -> `sourceMissing` flag, never node
 * deletion — pixel-node-import.md re-hydration contract), then mark all
 * nodes draft-dirty so the scheduler rebuilds every cache.
 */
export async function loadProject(
  path: string,
  deps: ProjectIoDeps = tauriProjectIoDeps,
): Promise<void> {
  let scene: Scene;
  try {
    scene = parseProject(await deps.readTextFile(path));
  } catch (err) {
    toast.error(`Couldn't open ${filenameOf(path)}`, {
      description: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const store = useSceneStore.getState();
  store.loadScene(scene);
  sources.clearAll();

  for (const node of scene.nodes) {
    if (!isPixelNode(node)) continue;
    try {
      const bitmap = await deps.decode(await deps.readFile(node.sourcePath));
      sources.set(node.id, bitmap as ImageBitmap);
      sources.useSourceMissingStore.getState().clear(node.id);
    } catch {
      // sourcePath kept verbatim in the scene — saves back without loss.
      sources.useSourceMissingStore.getState().setMissing(node.id, true);
    }
  }

  for (const node of scene.nodes) {
    useSceneStore.getState().markDirty(node.id, 'draft');
  }

  const meta = useProjectMetaStore.getState();
  meta.setPath(path);
  meta.markSaved();

  // History is per-session, never persisted (epic 13 scope) — a fresh load
  // clears both stacks so Cmd+Z can't reach back into a different document.
  // Cleared at the end (not the start) so it wins over anything this
  // function's own mutations pushed on the way in.
  history.clear();
}

/**
 * File → New (native-menu.md gap, 2026-07-04): respects the unsaved-changes
 * guard (same confirm-dialog pattern as `closeGuard.ts`'s close prompt),
 * then resets the scene to empty. Mirrors `loadProject`'s teardown of
 * caches/sources/history, but to the empty state rather than a loaded one.
 *
 * `confirmDiscard` is injected for tests (same pattern as `ProjectIoDeps`);
 * production wires the real Tauri `confirm` dialog.
 */
export async function newProject(
  confirmDiscard: (message: string) => Promise<boolean> = (message) =>
    confirm(message, { title: PRODUCT_NAME, kind: 'warning' }),
): Promise<void> {
  if (useProjectMetaStore.getState().dirtySinceSave) {
    const discard = await confirmDiscard(
      'You have unsaved changes. Discard them and start a new project?',
    );
    if (!discard) return;
  }

  useSceneStore.getState().resetScene();
  cache.clearAll();
  sources.clearAll();

  const meta = useProjectMetaStore.getState();
  meta.setPath(null);
  meta.markSaved();

  // Same end-of-function ordering as loadProject: clear history last so it
  // wins over the undo-stack push this function's own resetScene mutation
  // would otherwise have caused (per-session only, never persisted).
  history.clear();
}

/**
 * Cmd+O entry point: one dialog for both project files and images, routed
 * by extension (project-persistence.md §Behaviour).
 */
export async function openAnythingDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: true,
    filters: [{ name: 'Oblique project or image', extensions: ['oblique', 'png', 'jpg', 'jpeg'] }],
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];

  const projects = paths.filter((p) => p.toLowerCase().endsWith('.oblique'));
  const images = paths.filter((p) => !p.toLowerCase().endsWith('.oblique'));
  if (projects.length > 0) {
    await loadProject(projects[0]); // one project at a time; extras ignored
  }
  if (images.length > 0) {
    await importFiles(images, tauriImportDeps);
  }
}

// Any scene mutation after the last save marks the project dirty. loadScene
// and save both call markSaved afterwards, which wins because they run
// after their own store mutations have fired this subscription.
useSceneStore.subscribe((state, prev) => {
  if (state.scene !== prev.scene) useProjectMetaStore.getState().markMutated();
});
