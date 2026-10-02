import { create } from 'zustand';
import { resolveSourcePath, type UnresolvableReason } from '@/project/resolvePath';

/** Anything with a `.close()`, so tests can stub `ImageBitmap` without a real one. */
export interface Closable {
  close?: () => void;
}

/**
 * Module-scope map, deliberately outside React/Zustand state — same pattern
 * as `cache.ts`. Holds the full-resolution **source** bitmap decoded from a
 * pixel node's file (import or re-hydration on project load); the cook
 * pipeline downscales from this per resolution level. Never put an
 * `ImageBitmap` inside the persisted scene object.
 */
const sourceMap = new Map<string, ImageBitmap>();

function closeBitmap(bitmap: (ImageBitmap & Closable) | undefined): void {
  bitmap?.close?.();
}

/** Read the full-resolution source bitmap for a node, if decoded. */
export function get(nodeId: string): ImageBitmap | undefined {
  return sourceMap.get(nodeId);
}

/** Store a decoded source bitmap, closing whatever it replaces. */
export function set(nodeId: string, bitmap: ImageBitmap): void {
  closeBitmap(sourceMap.get(nodeId));
  sourceMap.set(nodeId, bitmap);
}

/** Evict and close a node's source bitmap. */
export function remove(nodeId: string): void {
  closeBitmap(sourceMap.get(nodeId));
  sourceMap.delete(nodeId);
}

/** Test-only escape hatch: drop everything. */
export function clearAll(): void {
  for (const nodeId of sourceMap.keys()) remove(nodeId);
}

/**
 * Re-hydration contract (see feature/pixel-node-import.md): on project load,
 * a pixel node whose `sourcePath` can't be re-decoded is NEVER deleted — it
 * stays in the scene, flagged here in a transient map that lives outside the
 * persisted scene entirely. The paint-time striped-placeholder rendering is
 * cook-pipeline's job; this store only carries the flag.
 */
/** Why a source is missing — drives the Image section's explanation line. */
export type SourceMissingReason = 'not-found' | 'unreadable' | UnresolvableReason;

interface SourceMissingState {
  missing: Record<string, boolean>;
  /** Present alongside `missing[id]`; absent means the generic `'not-found'`. */
  reasons: Record<string, SourceMissingReason>;
  setMissing: (nodeId: string, isMissing: boolean, reason?: SourceMissingReason) => void;
  clear: (nodeId: string) => void;
}

export const useSourceMissingStore = create<SourceMissingState>((set) => ({
  missing: {},
  reasons: {},
  setMissing: (nodeId, isMissing, reason = 'not-found') =>
    set((s) => ({
      missing: { ...s.missing, [nodeId]: isMissing },
      reasons: { ...s.reasons, [nodeId]: reason },
    })),
  clear: (nodeId) =>
    set((s) => {
      const { [nodeId]: _removed, ...rest } = s.missing;
      const { [nodeId]: _reason, ...restReasons } = s.reasons;
      return { missing: rest, reasons: restReasons };
    }),
}));

/** Convenience non-hook read, for code outside React components. */
export function isSourceMissing(nodeId: string): boolean {
  return Boolean(useSourceMissingStore.getState().missing[nodeId]);
}

/** Why `nodeId` is missing, or `null` when it isn't. */
export function missingReason(nodeId: string): SourceMissingReason | null {
  const state = useSourceMissingStore.getState();
  if (!state.missing[nodeId]) return null;
  return state.reasons[nodeId] ?? 'not-found';
}

/** The fs/decode edge every source read goes through (same shape as `ImportDeps`). */
export interface SourceReadDeps {
  readFile: (path: string) => Promise<Uint8Array>;
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number } & Closable>;
}

export type SourceLoad =
  | { ok: true; bitmap: ImageBitmap }
  | { ok: false; reason: SourceMissingReason };

/**
 * Resolve a stored `sourcePath` (project/resolvePath.ts — the one resolver)
 * and read + decode it. Never throws; a failure says why. This is the single
 * entry for every pixel-source read: project load, undo/redo re-hydration,
 * duplicate, replace and the post-save relative-path recheck.
 */
export async function loadSource(
  stored: string,
  projectPath: string | null,
  deps: SourceReadDeps,
): Promise<SourceLoad> {
  const resolved = resolveSourcePath(stored, projectPath);
  if (resolved.kind === 'unresolvable') return { ok: false, reason: resolved.reason };
  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(resolved.absPath);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  try {
    return { ok: true, bitmap: (await deps.decode(bytes)) as ImageBitmap };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** Land a `loadSource` result: hold the bitmap and clear the flag, or flag it missing with the reason. */
export function applySourceLoad(nodeId: string, load: SourceLoad): void {
  if (load.ok) {
    set(nodeId, load.bitmap);
    useSourceMissingStore.getState().clear(nodeId);
  } else {
    useSourceMissingStore.getState().setMissing(nodeId, true, load.reason);
  }
}
