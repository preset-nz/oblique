import { ModelDeclined, useModelGate } from '@preset.nz/app-kit/models';
import { notify } from '@preset.nz/ux-kit';
import { mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { productionSelectPayloadDeps } from '@/canvas/selectShared/payload';
import { cookNodeFullRes } from '@/cook/cook';
import { depthDir, depthRelativePath, pendingDepthPath } from '@/project/depthFiles';
import { tauriImportDeps } from '@/project/import';
import { setPending } from '@/project/pendingFiles';
import { useProjectMetaStore } from '@/project/projectMeta';
import * as cache from '@/scene/cache';
import { useSelectionStore } from '@/scene/selection';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import { beginTransaction, endTransaction } from '@/scene/transaction';
import type { SceneNode } from '@/scene/types';
import { isSelectionNode } from '@/scene/types';
import {
  DEPTH_MODEL_ID,
  type DepthBits,
  type DepthOptions,
  type DepthResult,
  depth,
} from './sidecarDepth';
import { ModelMissingError } from './sidecarSegment';

/**
 * Layer > Create Depth Map (Epic 17 story 5, `depth-map.md`). A command that makes a layer, not
 * a modifier: the depth map is content, so it does not follow later edits to the source.
 *
 *  1. The ask-first gate (`ensure`), as Smart Select has it: no network request until Download.
 *  2. The source's full-resolution cooked raster goes to the sidecar; the PNG comes back.
 *  3. The bytes are written to `<project>.depth/<id>.png` as they are, and decoded. In an Untitled
 *     document they are held in memory instead, until the first Save (`pendingFiles.ts`).
 *  4. One undo step adds a `PixelNode` named `<layer> depth` directly above the source, with
 *     the source's 2D transform so it sits over it. The source is not touched.
 *
 * Not in `<project>.baked/`: `writeBakedSidecar` sweeps every file there that is not a locked
 * node's bake, so a depth map kept there would go on the next save.
 */

/** The user-facing name of the model's job: the gate's `for`, in the prompt and Settings. */
export const DEPTH_MAP_FOR = 'Create depth map';

export interface CreateDepthMapDeps {
  /** `useModelGate().ensure`: resolves once the model is installed, rejects `ModelDeclined` on Not now. */
  ensure: (id: string, options?: { for?: string }) => Promise<void>;
  /** The source's cooked raster at full resolution, as RGBA8 bytes. */
  readRaster: (nodeId: string) => Promise<Pick<DepthOptions, 'image' | 'width' | 'height'>>;
  depth: (options: DepthOptions) => Promise<DepthResult>;
  projectPath: () => string | null;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Holds a file in memory under a placeholder path (`project/pendingFiles.ts`). */
  keepPending: (path: string, bytes: Uint8Array) => void;
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number } & sources.Closable>;
  notify: typeof notify;
  newId: () => string;
}

/** Layers a depth map can be made from: anything that cooks, but not a hidden selection shape. */
export function canCreateDepthMap(node: SceneNode | undefined): boolean {
  if (!node) return false;
  if (node.type !== 'pixel' && node.type !== 'vector' && node.type !== 'text') return false;
  return !isSelectionNode(node);
}

async function readRasterFromCooks(nodeId: string) {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  // A locked layer's frozen bake is its raster (as export reads it); else cook at full size.
  const baked = node?.state === 'locked' ? cache.get(nodeId, 'baked') : undefined;
  const bitmap = baked ?? (await cookNodeFullRes(nodeId));
  try {
    return {
      image: productionSelectPayloadDeps.readBitmap(bitmap),
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    if (!baked) bitmap.close();
  }
}

export function productionCreateDepthMapDeps(
  ensure: CreateDepthMapDeps['ensure'],
): CreateDepthMapDeps {
  return {
    ensure,
    readRaster: readRasterFromCooks,
    depth: (options) => depth(options),
    projectPath: () => useProjectMetaStore.getState().path,
    mkdir: (path, options) => mkdir(path, options),
    writeFile: (path, bytes) => writeFile(path, bytes),
    keepPending: setPending,
    decode: tauriImportDeps.decode,
    notify,
    newId: () => crypto.randomUUID(),
  };
}

/** The production wiring for the Layer menu: the model gate comes from the hook. */
export function useCreateDepthMap(): (nodeId: string, bits: DepthBits) => Promise<string | null> {
  const { ensure } = useModelGate();
  return (nodeId, bits) => createDepthMap(nodeId, bits, productionCreateDepthMapDeps(ensure));
}

/**
 * Returns the new layer's id, or `null` when nothing was added: no such layer, an Untitled
 * project, Not now, or a failure (said with a notification; never thrown).
 */
export async function createDepthMap(
  nodeId: string,
  bits: DepthBits,
  deps: CreateDepthMapDeps,
): Promise<string | null> {
  const source = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  if (!canCreateDepthMap(source)) return null;

  try {
    await deps.ensure(DEPTH_MODEL_ID, { for: DEPTH_MAP_FOR });
  } catch (err) {
    if (!(err instanceof ModelDeclined)) failed(deps, err);
    return null;
  }

  let bitmap: ({ width: number; height: number } & sources.Closable) | null = null;
  let relativePath: string;
  try {
    const raster = await deps.readRaster(nodeId);
    const result = await deps.depth({ ...raster, bits });
    const fileName = `${deps.newId()}.png`;
    const projectPath = deps.projectPath();
    if (projectPath === null) {
      // Untitled: nowhere to write yet. The bytes are held, named by a placeholder path, and the
      // first Save writes them and repoints the layer (`project/depthFiles.ts`).
      relativePath = pendingDepthPath(fileName);
      deps.keepPending(relativePath, result.png);
    } else {
      await deps.mkdir(depthDir(projectPath), { recursive: true });
      await deps.writeFile(`${depthDir(projectPath)}/${fileName}`, result.png);
      relativePath = depthRelativePath(projectPath, fileName);
    }
    bitmap = await deps.decode(result.png);
  } catch (err) {
    bitmap?.close?.();
    failed(deps, err);
    return null;
  }

  // The scene may have changed while the sidecar worked.
  const store = useSceneStore.getState();
  const index = store.scene.nodes.findIndex((n) => n.id === nodeId);
  const live = store.scene.nodes[index];
  if (!live) {
    bitmap.close?.();
    return null;
  }

  // No await from here to the end: the layer, its position and its bitmap land together, and
  // the gesture makes them one undo step.
  beginTransaction();
  let newId: string;
  try {
    newId = store.addPixelNode({
      sourcePath: relativePath,
      sourceSize: [bitmap.width, bitmap.height],
      label: `${live.label} depth`,
    });
    // `addPixelNode` puts the layer on top of the stack; directly above the source is the
    // source's own index (0 is the top).
    store.reorderNode(newId, index);
    if (live.transform2d) store.setNodeTransform(newId, live.transform2d);
    sources.set(newId, bitmap as ImageBitmap);
    sources.useSourceMissingStore.getState().clear(newId);
  } finally {
    endTransaction();
  }
  useSelectionStore.getState().selectNode(newId);
  return newId;
}

function failed(deps: CreateDepthMapDeps, err: unknown): void {
  if (err instanceof ModelMissingError) {
    deps.notify({
      kind: 'error',
      message: "Depth Anything V2 Small isn't installed",
      description: 'Choose Create Depth Map again to download it.',
    });
    return;
  }
  deps.notify({
    kind: 'error',
    message: "Couldn't create the depth map",
    description: err instanceof Error ? err.message : String(err),
  });
}
