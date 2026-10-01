/**
 * Prefix-cache storage (design/prefix-caching.md, story prefix-cache.md).
 *
 * Module-scope map beside `cache.ts`/`sources.ts`: raw RGBA8 buffers are
 * non-serialisable and never belong in the Zustand scene. It lives in
 * `src/scene/` rather than next to the cook executor because `deleteNode`
 * and `history` (both `scene/`) must clear it, and depcruise forbids
 * `scene/` importing `cook/`. The pure helpers and the cook-side wiring are
 * in `src/cook/prefixCache.ts`, which re-exports this module.
 *
 * Nothing here decides validity — an entry is only reused when its
 * descriptor structurally matches the current inputs (see `cook.ts`); this
 * module just holds, bounds and clears.
 */

/** Cook levels that keep a prefix. Local so `scene/` never imports `cook/`. */
export type PrefixLevel = 'draft' | 'working';

export interface PrefixDescriptor {
  /** Identity of the source pixels: the `ImageBitmap` (compared with `===`) for pixel nodes, a content key string for vector/text nodes. */
  source: ImageBitmap | string;
  /** Cook target size — also captures the level factor and the source/document size. */
  width: number;
  height: number;
  /** Enabled-modifier descriptor strings (document-space, mask inputs resolved) the bytes have had applied. */
  modifiers: string[];
}

export interface PrefixEntry {
  descriptor: PrefixDescriptor;
  /** RGBA8, `width * height * 4`: the source with `descriptor.modifiers` applied. Owned by the cache — copy before handing on. */
  bytes: Uint8Array;
}

interface NodeSlot {
  draft?: PrefixEntry;
  working?: PrefixEntry;
  /** Descriptors of the last successfully-cooked full stack per level — no bytes, used only to infer the edit point. */
  lastStack?: Partial<Record<PrefixLevel, string[]>>;
}

/** Global cap on nodes holding prefix state; scrubbing is one-node-at-a-time, 2 covers A/B flipping. */
export const PREFIX_NODE_CAP = 2;

/** Insertion order = recency: the first key is the least recently used. */
const slots = new Map<string, NodeSlot>();

/** Move a slot to most-recent. */
function touch(nodeId: string, slot: NodeSlot): void {
  slots.delete(nodeId);
  slots.set(nodeId, slot);
}

/** Get-or-create a slot as most-recent, evicting the least recent beyond the cap. */
function claim(nodeId: string): NodeSlot {
  const slot = slots.get(nodeId) ?? {};
  touch(nodeId, slot);
  while (slots.size > PREFIX_NODE_CAP) {
    const oldest = slots.keys().next().value;
    if (oldest === undefined) break;
    slots.delete(oldest);
  }
  return slot;
}

/** The stored entry for a node/level, if any. A hit counts as use for LRU purposes. */
export function getPrefix(nodeId: string, level: PrefixLevel): PrefixEntry | undefined {
  const slot = slots.get(nodeId);
  if (!slot) return undefined;
  touch(nodeId, slot);
  return slot[level];
}

/** Store (replace) the entry for a node/level; this node becomes most-recent. */
export function setPrefix(nodeId: string, level: PrefixLevel, entry: PrefixEntry): void {
  claim(nodeId)[level] = entry;
}

/** The last cooked stack's descriptors for a node/level, if remembered. Does not count as use. */
export function getLastStack(nodeId: string, level: PrefixLevel): string[] | undefined {
  return slots.get(nodeId)?.lastStack?.[level];
}

export function setLastStack(nodeId: string, level: PrefixLevel, descriptors: string[]): void {
  const slot = claim(nodeId);
  slot.lastStack = { ...slot.lastStack, [level]: descriptors };
}

/** Drop everything held for a node (node delete). */
export function clearNode(nodeId: string): void {
  slots.delete(nodeId);
}

/** Drop everything (project open / new). */
export function clearAll(): void {
  slots.clear();
}

/** Node ids currently holding state, least recent first. Test/diagnostic aid. */
export function heldNodeIds(): string[] {
  return [...slots.keys()];
}
