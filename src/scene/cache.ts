import { create } from 'zustand';

/** Anything with a `.close()`, so tests can stub `ImageBitmap` without a real one. */
export interface Closable {
  close?: () => void;
}

export interface NodeCacheEntry {
  draft?: ImageBitmap;
  working?: ImageBitmap;
  baked?: ImageBitmap;
}

type CacheLevel = keyof NodeCacheEntry;

/**
 * Module-scope map, deliberately outside React/Zustand state: bitmaps are
 * non-serialisable and mutate far more often than anything worth rendering
 * on. Consumers subscribe to `useCacheVersionStore` to know "something
 * cooked" without holding bitmaps themselves.
 */
const cacheMap = new Map<string, NodeCacheEntry>();

interface CacheVersionState {
  cacheVersion: number;
  bump: () => void;
}

export const useCacheVersionStore = create<CacheVersionState>((set) => ({
  cacheVersion: 0,
  bump: () => set((s) => ({ cacheVersion: s.cacheVersion + 1 })),
}));

function closeBitmap(bitmap: (ImageBitmap & Closable) | undefined): void {
  bitmap?.close?.();
}

/** Read the cached bitmap for a node/level, if any. */
export function get(nodeId: string, level: CacheLevel): ImageBitmap | undefined {
  return cacheMap.get(nodeId)?.[level];
}

/** Store a cooked bitmap, closing whatever it replaces at that level. */
export function set(nodeId: string, level: CacheLevel, bitmap: ImageBitmap): void {
  const entry = cacheMap.get(nodeId) ?? {};
  closeBitmap(entry[level]);
  entry[level] = bitmap;
  cacheMap.set(nodeId, entry);
  useCacheVersionStore.getState().bump();
}

/** Evict and close a single level's bitmap for a node. */
export function clearLevel(nodeId: string, level: CacheLevel): void {
  const entry = cacheMap.get(nodeId);
  if (!entry) return;
  closeBitmap(entry[level]);
  delete entry[level];
  useCacheVersionStore.getState().bump();
}

/** Evict and close every level's bitmap for a node, then drop the entry. */
export function clearNode(nodeId: string): void {
  const entry = cacheMap.get(nodeId);
  if (!entry) return;
  closeBitmap(entry.draft);
  closeBitmap(entry.working);
  closeBitmap(entry.baked);
  cacheMap.delete(nodeId);
  useCacheVersionStore.getState().bump();
}

/** Test-only escape hatch: drop everything without a version bump per-call. */
export function clearAll(): void {
  for (const nodeId of cacheMap.keys()) clearNode(nodeId);
}
