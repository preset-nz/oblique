import { create } from 'zustand';

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
interface SourceMissingState {
  missing: Record<string, boolean>;
  setMissing: (nodeId: string, isMissing: boolean) => void;
  clear: (nodeId: string) => void;
}

export const useSourceMissingStore = create<SourceMissingState>((set) => ({
  missing: {},
  setMissing: (nodeId, isMissing) =>
    set((s) => ({ missing: { ...s.missing, [nodeId]: isMissing } })),
  clear: (nodeId) =>
    set((s) => {
      const { [nodeId]: _removed, ...rest } = s.missing;
      return { missing: rest };
    }),
}));

/** Convenience non-hook read, for code outside React components. */
export function isSourceMissing(nodeId: string): boolean {
  return Boolean(useSourceMissingStore.getState().missing[nodeId]);
}
