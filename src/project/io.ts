import { notify } from '@preset.nz/ux-kit';
import { confirm, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { mkdir, readDir, remove, writeFile } from '@tauri-apps/plugin-fs';
import { PRODUCT_NAME } from '@/branding';
import { useMissingFontsStore } from '@/fonts/missingFonts';
import { isRefused } from '@/rhizome/refusal';
import { type Rhizome, rhizome } from '@/rhizome/rhizome';
import * as backgroundSource from '@/scene/backgroundSource';
import * as cache from '@/scene/cache';
import * as prefixStore from '@/scene/prefixStore';
import { type ReplaceSourceResult, replacePixelSource } from '@/scene/replaceSource';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import { isPixelNode } from '@/scene/types';
import { filenameOf, type ImportDeps, importFiles, tauriImportDeps } from './import';
import { useProjectMetaStore } from './projectMeta';
import { isRelativeSourcePath, resolveSourcePath } from './resolvePath';

export { useProjectMetaStore };

/** The image-type open-dialog filter shared by Import, Choose image… and Replace Image…. */
const IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }];

/**
 * Projects are rhizome documents (Epic 21 story 1): Open, New and Save go through the
 * document host (`rhizome/`), which owns the file format, the `.oblique` extension and the
 * unsaved state. What stays here is what rhizome knows nothing about: the baked bitmaps beside
 * the file, the decoded sources and the caches.
 */
function host(): Rhizome {
  const r = rhizome();
  if (!r) throw new Error("The document host isn't running");
  return r;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
export async function writeBakedSidecar(
  path: string,
  scene: Scene,
  deps: ProjectIoDeps,
): Promise<void> {
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
 * Relative source paths (image-source.md) resolve against the saved project's
 * folder, so a first Save or a Save As to another folder changes what they
 * point at. Re-run the re-decode for every pixel node whose resolved file
 * differs between the old and new project path (and the background, which
 * shares the resolver), so the missing flags are true straight away. Absolute
 * paths never change.
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
    // The missing flag alone doesn't repaint the canvas; a dirty mark does. A node that comes
    // good at a different size than its `sourceSize` used to be fitted here (a write); that
    // write isn't on rhizome yet, so the node keeps its footprint. deferred: Epic 21 story 2
    store.markDirty(node.id, 'draft');
  }
  if (scene.background?.type === 'image' && isRelativeSourcePath(scene.background.sourcePath)) {
    await backgroundSource.reconcile(scene.background, deps, newPath, { force: true });
  }
}

/**
 * Save to the current path, or run save-as when there is none (or `as` forces it). The
 * document goes through rhizome; the baked bitmaps for locked layers are written beside the
 * file it names (baked-persistence.md).
 */
export async function saveProject(
  options: { as?: boolean } = {},
  deps: ProjectIoDeps = tauriProjectIoDeps,
): Promise<void> {
  const previousPath = useProjectMetaStore.getState().path;
  let picked: string | null = null;
  if (options.as || !previousPath) {
    picked = await saveDialog({
      filters: [{ name: `${PRODUCT_NAME} project`, extensions: ['oblique'] }],
    });
    if (!picked) return;
  }
  try {
    const r = host();
    const status = picked === null ? await r.save() : await r.saveAs(picked);
    // rhizome adds the extension when the name has none: the file is where it says it is
    const path = status.path ?? picked ?? previousPath;
    if (!path) throw new Error('The document has no file');
    await writeBakedSidecar(path, useSceneStore.getState().scene, deps);
    // The base folder for relative source paths just changed (first save, or Save As
    // elsewhere): re-run the re-decode so the missing flags tell the truth now, not at the
    // next load.
    if (path !== previousPath) await recheckRelativeSources(previousPath, path, deps);
  } catch (err) {
    notify({
      message: "Couldn't save project",
      kind: 'error',
      description: messageOf(err),
    });
  }
}

/**
 * Open a `.oblique` file: rhizome reads it (anything that isn't its format is refused with
 * its own error, and nothing changes), then the store is rebuilt from the document, every
 * pixel source is re-decoded (missing file -> `sourceMissing` flag, never node deletion —
 * pixel-node-import.md re-hydration contract), and every node is marked draft-dirty so the
 * scheduler rebuilds every cache.
 */
export async function loadProject(
  path: string,
  deps: ProjectIoDeps = tauriProjectIoDeps,
): Promise<void> {
  let issues: { path: string; message: string }[];
  try {
    issues = await host().replaceDocument({ kind: 'open', path }, async (target) => {
      // The old project's cache entries go before this one's baked-bitmap rehydration
      // populates fresh ones — leaving them leaks full-res ImageBitmaps across every Open.
      // Done only now, with the file read and accepted: a refused file changes nothing.
      cache.clearAll();
      prefixStore.clearAll();
      sources.clearAll();
      backgroundSource.clear(); // like sources: a load always re-decodes
      await rehydrateBaked(path, target, deps);
    });
  } catch (err) {
    notify({
      message: `Couldn't open ${filenameOf(path)}`,
      kind: 'error',
      description: messageOf(err),
    });
    return;
  }

  // Reopening the file that is open keeps its node ids, which restoreScene reads as
  // unchanged; the caches were just cleared, so say so.
  for (const node of useSceneStore.getState().scene.nodes) {
    useSceneStore.getState().markDirty(node.id, 'draft');
  }

  if (issues.length > 0) {
    notify({
      kind: 'warning',
      message: `${filenameOf(path)} opened with ${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`,
      description: issues
        .slice(0, 3)
        .map((i) => i.message)
        .join('\n'),
    });
  }

  // Missing fonts (missing-fonts.md): one warning per open, shown now if the
  // catalogue is ready, otherwise as soon as it is.
  useMissingFontsStore.getState().documentOpened();
}

/**
 * Baked-bitmap rehydration (baked-persistence.md) runs BEFORE the scene lands in the store:
 * the scheduler subscribes to scene changes and its rehydrate check (cook/scheduler.ts)
 * fires synchronously on that subscription. Populating the `baked` cache slot first means a
 * normal reopen finds every locked node's slot already full and issues zero cook requests;
 * only a missing/corrupt PNG leaves the slot empty for the scheduler's one-shot rehydrate
 * cook to recover (the single recovery path — never a second mechanism here).
 */
async function rehydrateBaked(path: string, target: Scene, deps: ProjectIoDeps): Promise<void> {
  for (const node of target.nodes) {
    if (node.state !== 'locked') continue;
    try {
      const bytes = await deps.readFile(`${bakedDirFor(path)}/${node.id}.png`);
      const bitmap = await deps.decode(bytes);
      cache.set(node.id, 'baked', bitmap as ImageBitmap);
    } catch (err) {
      // Non-fatal by design: a missing sidecar or a corrupt one both fall through to the
      // scheduler's rehydrate path.
      console.warn(`[project] baked bitmap for ${node.id} missing/corrupt, will recook`, err);
    }
  }
}

/**
 * File → New (native-menu.md gap, 2026-07-04): respects the unsaved-changes
 * guard (same confirm-dialog pattern as `closeGuard.ts`'s close prompt),
 * then replaces the document with a new one (rhizome's `seed`: empty, size 0×0).
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

  try {
    await host().replaceDocument({ kind: 'new' }, async () => {
      cache.clearAll();
      prefixStore.clearAll();
      sources.clearAll();
      backgroundSource.clear();
    });
  } catch (err) {
    notify({ message: "Couldn't start a new project", kind: 'error', description: messageOf(err) });
    return;
  }
  useMissingFontsStore.getState().documentCleared();
}

/**
 * What to open when macOS launches the app with a file, and when it asks for another while
 * it runs (`takeLaunchPath`, `pom://open-document`): the same path as Cmd+O.
 */
export async function attachDocumentOpening(r: Rhizome): Promise<void> {
  const launched = r.takeLaunchPath();
  if (launched) void loadProject(launched);
  await r.onOpenDocument((path) => void loadProject(path));
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
  if (isRefused('setBackgroundImage')) {
    // Before decoding or holding anything: the store's refusing action toasts and does
    // nothing, so a bitmap held now would paint a background the scene doesn't have.
    useSceneStore.getState().setBackgroundImage(path, [0, 0]);
    return false;
  }
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
    notify({
      message: `Couldn't use ${filenameOf(path)} as the background`,
      kind: 'error',
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
