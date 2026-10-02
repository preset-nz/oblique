import { confirm, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import { PRODUCT_NAME } from '@/branding';
import { useMissingFontsStore } from '@/fonts/missingFonts';
import * as backgroundSource from '@/scene/backgroundSource';
import * as cache from '@/scene/cache';
import * as history from '@/scene/history';
import * as prefixStore from '@/scene/prefixStore';
import { type ReplaceSourceResult, replacePixelSource } from '@/scene/replaceSource';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import { isPixelNode } from '@/scene/types';
import { filenameOf, type ImportDeps, importFiles, tauriImportDeps } from './import';
import { useProjectMetaStore } from './projectMeta';
import { isRelativeSourcePath, resolveSourcePath } from './resolvePath';

// On-disk format identifiers, deliberately not `PRODUCT_NAME`: the marker and
// the `.oblique` extension must survive a product rename or existing files
// stop opening. Only displayed strings route through branding.
export const PROJECT_FORMAT = 'oblique-project';
// v2 (baked-persistence.md, 2026-07-06): scene shape is unchanged — v2 only
// *means* "a `<name>.oblique.baked/` sidecar dir may exist beside this file".
// Saves always write 2; loads accept 1 and 2.
export const PROJECT_VERSION = 2;
const MIN_SUPPORTED_VERSION = 1;
const MAX_SUPPORTED_VERSION = 2;

export { useProjectMetaStore };

/** The image-type open-dialog filter shared by Import, Choose image… and Replace Image…. */
const IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }];

/** Serialise the scene to the on-disk project JSON (format doc: project-persistence.md). */
export function serialiseProject(scene: Scene): string {
  return JSON.stringify(
    { format: PROJECT_FORMAT, version: PROJECT_VERSION, saved: new Date().toISOString(), scene },
    null,
    2,
  );
}

/**
 * Parse + validate project JSON. Throws with a user-showable message; never
 * half-loads. `sourcePath` is optional and used only to name the file in the
 * legacy-`masks` warning below (callers without a path, e.g. tests, just get
 * an unnamed warning).
 */
export function parseProject(text: string, sourcePath?: string): Scene {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const record = doc as Record<string, unknown>;
  if (record?.format !== PROJECT_FORMAT) {
    throw new Error(`not an ${PRODUCT_NAME} project file`);
  }
  const version = record.version;
  if (
    typeof version !== 'number' ||
    version < MIN_SUPPORTED_VERSION ||
    version > MAX_SUPPORTED_VERSION
  ) {
    throw new Error(
      `unsupported project version ${String(version)} (expected ${MIN_SUPPORTED_VERSION}-${MAX_SUPPORTED_VERSION})`,
    );
  }
  if (typeof record.scene !== 'object' || record.scene === null) {
    throw new Error('project file has no scene');
  }
  const scene = record.scene as Record<string, unknown> & Scene;
  // Baked masks (MaskDef via Scene.masks) are retired (retire-baked-masks.md,
  // 2026-09-10) — no migration, just warn and drop so the Scene stays typed.
  if ('masks' in scene) {
    const masks = scene.masks as Record<string, unknown> | undefined;
    const count = masks ? Object.keys(masks).length : 0;
    console.warn(
      `[project] ${sourcePath ?? 'project file'}: dropping ${count} legacy baked mask(s) (masks are retired)`,
    );
    delete scene.masks;
  }
  migrateLegacyTextKerning(scene);
  return scene;
}

/**
 * Epic 20 story 4b: `TextNode.kerning` went from a boolean to a percentage
 * (0–200, 100 = the font's own pairs). A saved `true` loads as 100 and `false`
 * as 0; a missing or otherwise non-numeric value is the default, 100. Mutates
 * the freshly parsed scene in place, before `loadScene`.
 */
function migrateLegacyTextKerning(scene: Scene): void {
  if (!Array.isArray(scene.nodes)) return;
  for (const node of scene.nodes) {
    if (node?.type !== 'text') continue;
    const text = node as unknown as { kerning?: unknown };
    if (typeof text.kerning === 'boolean') text.kerning = text.kerning ? 100 : 0;
    else if (typeof text.kerning !== 'number' || !Number.isFinite(text.kerning)) text.kerning = 100;
  }
}

/** A single entry from a directory listing — the subset baked-dir sweeping needs. */
export interface DirEntry {
  name: string;
}

/**
 * File-system edges injected for tests (same pattern as `ImportDeps`);
 * decode is the pixel-source re-hydration path shared with import. The
 * mkdir/writeFile/readDir/remove/encodePng group is the baked-cache sidecar
 * primitive set (baked-persistence.md) — plain fs + one canvas-encode edge,
 * same injectable-deps pattern as everything else here.
 */
export interface ProjectIoDeps {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number } & sources.Closable>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  readDir: (path: string) => Promise<DirEntry[]>;
  remove: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  encodePng: (bitmap: ImageBitmap) => Promise<Uint8Array>;
}

async function encodeBitmapPng(bitmap: ImageBitmap): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

export const tauriProjectIoDeps: ProjectIoDeps = {
  readTextFile,
  writeTextFile,
  rename,
  readFile: tauriImportDeps.readFile,
  decode: tauriImportDeps.decode,
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, bytes) => writeFile(path, bytes),
  readDir: (path) => readDir(path),
  remove: (path, options) => remove(path, options),
  encodePng: encodeBitmapPng,
};

/** `/art/piece.oblique` -> `/art/piece.oblique.baked` (baked-persistence.md sidecar layout). */
function bakedDirFor(projectPath: string): string {
  return `${projectPath}.baked`;
}

async function removeIfExists(
  path: string,
  deps: ProjectIoDeps,
  options?: { recursive?: boolean },
): Promise<void> {
  try {
    await deps.remove(path, options);
  } catch {
    // Already gone — fine, this is a best-effort sweep/cleanup helper.
  }
}

/**
 * Persist the `baked` cache slot for every locked node as a PNG beside the
 * project file, sweep stale files (unlocked-then-saved, deleted nodes), and
 * drop the whole directory once nothing locked remains. A locked node whose
 * `baked` cache is empty (mid-rehydrate — lock-state-machine.md) is skipped,
 * not an error: its existing on-disk PNG (if any) is left alone since its
 * node id is still locked, and the next save after rehydration completes
 * writes the fresh bitmap.
 */
async function writeBakedSidecar(path: string, scene: Scene, deps: ProjectIoDeps): Promise<void> {
  const dir = bakedDirFor(path);
  const lockedIds = new Set(scene.nodes.filter((n) => n.state === 'locked').map((n) => n.id));

  if (lockedIds.size === 0) {
    await removeIfExists(dir, deps, { recursive: true });
    return;
  }

  await deps.mkdir(dir, { recursive: true });

  const writtenIds = new Set<string>();
  for (const id of lockedIds) {
    const bitmap = cache.get(id, 'baked');
    if (!bitmap) continue; // mid-rehydrate: skipped, not an error — next save catches it
    await deps.writeFile(`${dir}/${id}.png`, await deps.encodePng(bitmap));
    writtenIds.add(id);
  }

  let entries: DirEntry[] = [];
  try {
    entries = await deps.readDir(dir);
  } catch {
    entries = [];
  }

  // Files this call just wrote definitely survive, whether or not `readDir`
  // reflects them (real fs does; test stubs may not). Anything else in the
  // listing survives only if it still belongs to a currently-locked node
  // (a mid-rehydrate node's older PNG); everything else is stale and swept.
  let survivingCount = writtenIds.size;
  for (const entry of entries) {
    const id = entry.name.replace(/\.png$/, '');
    if (writtenIds.has(id)) continue;
    if (lockedIds.has(id)) {
      survivingCount++;
      continue;
    }
    await removeIfExists(`${dir}/${entry.name}`, deps);
  }

  if (survivingCount === 0) await removeIfExists(dir, deps, { recursive: true });
}

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
  await writeBakedSidecar(path, scene, deps);
}

/**
 * Relative source paths (image-source.md) resolve against the saved project's
 * folder, so a first Save or a Save As to another folder changes what they
 * point at. Re-run the re-decode for every pixel node whose resolved file
 * differs between the old and new project path (and the background, which
 * shares the resolver), so the missing flags are true straight away. Absolute
 * paths never change. A node that comes good with a different pixel size than
 * its `sourceSize` (typed while unresolvable, so the old footprint was kept) is
 * fitted like a replace, outside the undo history — this is bookkeeping the
 * save causes, not a user edit.
 */
export async function recheckRelativeSources(
  previousPath: string | null,
  newPath: string,
  deps: ProjectIoDeps,
): Promise<void> {
  const scene = useSceneStore.getState().scene;
  for (const node of scene.nodes) {
    if (!isPixelNode(node) || !isRelativeSourcePath(node.sourcePath)) continue;
    const before = resolveSourcePath(node.sourcePath, previousPath);
    const after = resolveSourcePath(node.sourcePath, newPath);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const load = await sources.loadSource(node.sourcePath, newPath, deps);
    // Deleted or re-pointed while decoding: drop the bitmap.
    const live = useSceneStore.getState().scene.nodes.find((n) => n.id === node.id);
    if (!live || !isPixelNode(live) || live.sourcePath !== node.sourcePath) {
      if (load.ok) (load.bitmap as sources.Closable).close?.();
      continue;
    }
    if (!load.ok) sources.remove(node.id); // never cook the old file's pixels for a path that no longer resolves
    sources.applySourceLoad(node.id, load);
    const store = useSceneStore.getState();
    history.withoutCapture(() => {
      // The missing flag alone doesn't repaint the canvas; a dirty mark does.
      if (!load.ok) store.markDirty(node.id, 'draft');
      else if (
        load.bitmap.width !== live.sourceSize[0] ||
        load.bitmap.height !== live.sourceSize[1]
      ) {
        store.setPixelSource(node.id, node.sourcePath, [load.bitmap.width, load.bitmap.height]);
      } else {
        store.markDirty(node.id, 'draft');
      }
    });
  }
  if (scene.background?.type === 'image' && isRelativeSourcePath(scene.background.sourcePath)) {
    await backgroundSource.reconcile(scene.background, deps, newPath, { force: true });
  }
}

/** Save to the current path, or run save-as when there is none (or `as` forces it). */
export async function saveProject(
  options: { as?: boolean } = {},
  deps: ProjectIoDeps = tauriProjectIoDeps,
): Promise<void> {
  const meta = useProjectMetaStore.getState();
  const previousPath = meta.path;
  let path = options.as ? null : meta.path;
  if (!path) {
    const picked = await saveDialog({
      filters: [{ name: `${PRODUCT_NAME} project`, extensions: ['oblique'] }],
    });
    if (!picked) return;
    path = picked;
  }
  try {
    await writeProjectFile(path, useSceneStore.getState().scene, deps);
    meta.setPath(path);
    // The base folder for relative source paths just changed (first save, or
    // Save As elsewhere): re-run the re-decode so the missing flags tell the
    // truth now, not at the next load. Before markSaved, like loadProject, so
    // the dirty-flag churn it causes doesn't leave the title marked edited.
    if (path !== previousPath) await recheckRelativeSources(previousPath, path, deps);
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
    scene = parseProject(await deps.readTextFile(path), path);
  } catch (err) {
    toast.error(`Couldn't open ${filenameOf(path)}`, {
      description: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Drop the previous project's cache entries before this project's own
  // baked-bitmap rehydration populates fresh ones below — node ids are
  // unique per project, so a stale entry could never be *read* wrong, but
  // leaving it around leaks full-res ImageBitmaps (including baked ones)
  // across every Open. Same mechanism `newProject` already uses.
  cache.clearAll();
  prefixStore.clearAll();

  // Baked-bitmap rehydration (baked-persistence.md) runs BEFORE the scene
  // lands in the store: the scheduler subscribes to scene changes and its
  // rehydrate check (cook/scheduler.ts) fires synchronously on that
  // subscription. Populating the `baked` cache slot first means a normal
  // reopen finds every locked node's slot already full and issues zero
  // cook requests; only a missing/corrupt PNG leaves the slot empty for the
  // scheduler's one-shot rehydrate cook to recover (the single recovery
  // path — never a second mechanism here).
  for (const node of scene.nodes) {
    if (node.state !== 'locked') continue;
    try {
      const bytes = await deps.readFile(`${bakedDirFor(path)}/${node.id}.png`);
      const bitmap = await deps.decode(bytes);
      cache.set(node.id, 'baked', bitmap as ImageBitmap);
    } catch (err) {
      // Non-fatal by design: missing sidecar (pre-v2 file, hand-deleted PNG)
      // or a corrupt one both fall through to the scheduler's rehydrate path.
      console.warn(`[project] baked bitmap for ${node.id} missing/corrupt, will recook`, err);
    }
  }

  const store = useSceneStore.getState();
  store.loadScene(scene);
  sources.clearAll();

  // `path` is passed explicitly: the project-meta path is only updated at the
  // end of this function, so reading it here would give the previous project's.
  for (const node of scene.nodes) {
    if (!isPixelNode(node)) continue;
    // sourcePath kept verbatim in the scene — saves back without loss. A
    // failed read flags the node missing (with the reason) and never deletes it.
    sources.applySourceLoad(node.id, await sources.loadSource(node.sourcePath, path, deps));
  }

  // Document background image (background-image.md): same re-decode as a
  // pixel source — missing/unreadable flags `missing`, never throws, keeps
  // `sourcePath` verbatim so a save writes it back unchanged.
  backgroundSource.clear(); // like sources.clearAll(): a load always re-decodes
  await backgroundSource.reconcile(scene.background, deps, path);

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

  // Missing fonts (missing-fonts.md): one warning per open, shown now if the
  // catalogue is ready, otherwise as soon as it is.
  useMissingFontsStore.getState().documentOpened();
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
  prefixStore.clearAll();
  sources.clearAll();
  backgroundSource.clear();

  const meta = useProjectMetaStore.getState();
  meta.setPath(null);
  meta.markSaved();

  // Same end-of-function ordering as loadProject: clear history last so it
  // wins over the undo-stack push this function's own resetScene mutation
  // would otherwise have caused (per-session only, never persisted).
  history.clear();
  useMissingFontsStore.getState().documentCleared();
}

/**
 * Cmd+O entry point (roadmap "Cmd+O is overloaded — split Open vs Import",
 * 2026-07-05): projects only. Genuinely a different flow from import —
 * replaces the whole project via `loadProject`, never adds a node.
 */
export async function openProjectDialog(): Promise<void> {
  const selected = await openDialog({
    filters: [{ name: `${PRODUCT_NAME} project`, extensions: ['oblique'] }],
  });
  if (!selected) return;
  const path = Array.isArray(selected) ? selected[0] : selected;
  await loadProject(path);
}

/**
 * Cmd+I entry point (roadmap "Cmd+O is overloaded — split Open vs Import",
 * 2026-07-05): images only, always adds node(s) via `importFiles` — never
 * touches the current project (no `loadProject` call, ever). Document-size
 * adoption rules live in `import.ts::importFile` (empty/unset doc only).
 */
export async function importImagesDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: true,
    filters: IMAGE_FILTERS,
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  await importFiles(paths, tauriImportDeps);
}

/**
 * Decode `path` and make it the document background. Never throws — a
 * decode failure is a toast (filename + reason) and the background is left
 * as it was, same contract as `importFile`. The bitmap goes into the holder
 * BEFORE the scene action so the recomposite the scene change triggers
 * already has pixels.
 */
export async function setBackgroundImageFromPath(
  path: string,
  deps: ImportDeps = tauriImportDeps,
): Promise<boolean> {
  try {
    // Through the shared resolver (image-source.md); the picker hands over an
    // absolute path, so this only differs for a path that isn't.
    const resolved = resolveSourcePath(path, useProjectMetaStore.getState().path);
    if (resolved.kind !== 'file') throw new Error("This path can't be resolved");
    const bitmap = await deps.decode(await deps.readFile(resolved.absPath));
    backgroundSource.set(path, bitmap as ImageBitmap);
    useSceneStore.getState().setBackgroundImage(path, [bitmap.width, bitmap.height]);
    return true;
  } catch (err) {
    toast.error(`Couldn't use ${filenameOf(path)} as the background`, {
      description: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Browse… in the Image section and Layer → Replace Image… (image-source.md):
 * the same image-type open dialog as Import, seeded with the folder of the
 * current resolved file when there is one. The pick is an absolute path
 * (decision 3) and goes through `replacePixelSource` like a typed one. Returns
 * null when cancelled or when `nodeId` isn't a pixel node.
 */
export async function replaceImageDialog(
  nodeId: string,
  deps: ImportDeps = tauriImportDeps,
): Promise<ReplaceSourceResult | null> {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  if (!node || !isPixelNode(node)) return null;
  const resolved = resolveSourcePath(node.sourcePath, useProjectMetaStore.getState().path);
  const folder =
    resolved.kind === 'file' && !sources.isSourceMissing(nodeId)
      ? resolved.absPath.slice(0, resolved.absPath.lastIndexOf('/')) || '/'
      : undefined;
  const selected = await openDialog({ filters: IMAGE_FILTERS, defaultPath: folder });
  if (!selected) return null;
  const path = Array.isArray(selected) ? selected[0] : selected;
  return replacePixelSource(nodeId, path, deps);
}

/** Document-setup "Choose image…": same file picker as Import, single file. */
export async function chooseBackgroundImageDialog(): Promise<void> {
  const selected = await openDialog({
    filters: IMAGE_FILTERS,
  });
  if (!selected) return;
  const path = Array.isArray(selected) ? selected[0] : selected;
  await setBackgroundImageFromPath(path);
}

// Any scene mutation after the last save marks the project dirty. loadScene
// and save both call markSaved afterwards, which wins because they run
// after their own store mutations have fired this subscription.
useSceneStore.subscribe((state, prev) => {
  if (state.scene !== prev.scene) useProjectMetaStore.getState().markMutated();
});
