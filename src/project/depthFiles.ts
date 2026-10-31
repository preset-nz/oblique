import { filenameOf } from '@/project/import';
import { getPending, isPendingPath } from '@/project/pendingFiles';
import { resolveSourcePath } from '@/project/resolvePath';
import { useSceneStore } from '@/scene/store';
import { beginTransaction, endTransaction } from '@/scene/transaction';
import { isPixelNode } from '@/scene/types';

/**
 * Where a depth map lives (Epic 17 story 5): `<project>.depth/<file>.png`, beside the project
 * file. Not in `<project>.baked/`, which `writeBakedSidecar` sweeps clean of anything that isn't
 * a locked layer's bake. A layer's `sourcePath` is relative to the project's folder, like any
 * source kept beside the project (image-source.md).
 */
export const depthDir = (projectPath: string): string => `${projectPath}.depth`;

export const depthRelativePath = (projectPath: string, fileName: string): string =>
  `${filenameOf(projectPath)}.depth/${fileName}`;

/** The placeholder source path of a depth map made before the first Save. */
export const pendingDepthPath = (fileName: string): string => `pending://depth/${fileName}`;

/** The file-system edges this needs: a subset of `ProjectIoDeps`, so `io.ts` passes its own. */
export interface DepthFileDeps {
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
}

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A relative `<name>.depth/<file>.png`: what this story's saved layers point at. */
const DEPTH_SOURCE = /^[^/]+\.depth\/[^/]+\.png$/;

/**
 * After a save (`projectDocumentEvents().saved`): put every depth map where the saved project
 * expects it.
 *
 * - A layer still holding a pending file (made in an Untitled document) gets its bytes written
 *   to `<project>.depth/<file>.png` and its `sourcePath` pointed there. The held bytes stay:
 *   undoing that repoint (or the layer's creation) leaves the placeholder path and needs them.
 * - On a Save As that moves the project (another folder or name), each depth map is copied into
 *   the new `<project>.depth/`, so the paths keep working; the old files are left where they are.
 *
 * Each repoint is a real edit, inside one gesture so all of them are one undo step (as
 * `recheckRelativeSources` is). One file failing doesn't stop the rest; the first error is
 * thrown at the end, for the caller's toast.
 */
export async function settleDepthFiles(
  previous: string | null,
  path: string,
  deps: DepthFileDeps,
): Promise<void> {
  const nodes = useSceneStore.getState().scene.nodes;
  const moved = previous !== null && previous !== path;
  const repoints: Array<[id: string, sourcePath: string]> = [];
  let firstError: unknown;
  let madeDir = false;

  const writeTo = async (fileName: string, bytes: Uint8Array) => {
    if (!madeDir) {
      await deps.mkdir(depthDir(path), { recursive: true });
      madeDir = true;
    }
    await deps.writeFile(`${depthDir(path)}/${fileName}`, bytes);
  };

  for (const node of nodes) {
    if (!isPixelNode(node)) continue;
    try {
      if (isPendingPath(node.sourcePath)) {
        const bytes = getPending(node.sourcePath);
        if (!bytes) continue; // already dropped: the layer stays flagged missing
        const fileName = lastSegment(node.sourcePath);
        await writeTo(fileName, bytes);
        repoints.push([node.id, depthRelativePath(path, fileName)]);
      } else if (moved && DEPTH_SOURCE.test(node.sourcePath)) {
        const fileName = lastSegment(node.sourcePath);
        const was = resolveSourcePath(node.sourcePath, previous);
        const next = depthRelativePath(path, fileName);
        const now = resolveSourcePath(next, path);
        if (was.kind !== 'file' || now.kind !== 'file' || was.absPath === now.absPath) continue;
        await writeTo(fileName, await deps.readFile(was.absPath));
        if (next !== node.sourcePath) repoints.push([node.id, next]);
      }
    } catch (err) {
      firstError ??= err;
    }
  }

  if (repoints.length > 0) {
    beginTransaction();
    try {
      for (const [id, sourcePath] of repoints) {
        useSceneStore.getState().setPixelSource(id, sourcePath);
      }
    } finally {
      endTransaction();
    }
  }
  if (firstError !== undefined) throw firstError;
}
