import { create } from 'zustand';
import type { Closable } from './sources';
import type { SceneBackground } from './types';

/**
 * Holder for the decoded document-background image (background-image.md) — a
 * sibling of `sources.ts`, same module-scope + close-on-evict discipline, but
 * a single `{ bitmap, sourcePath }` slot instead of a map keyed by node id:
 * the background is not a node and deliberately skips the draft/working/baked
 * cook pipeline (one-shot full-res decode). Never put the `ImageBitmap` in the
 * persisted scene; the scene only carries `{ type: 'image', sourcePath,
 * sourceSize }`.
 */
interface Held {
  bitmap: ImageBitmap;
  sourcePath: string;
}

let held: Held | undefined;

/**
 * The path the scene currently wants decoded. A decode that resolves after
 * the user has moved on (picked none/colour, another image, or undid) finds
 * `wanted` changed and discards its bitmap instead of landing it.
 */
let wanted: string | undefined;

/**
 * Transient, never persisted. `version` is the recomposite trigger: the
 * compositor only repaints on scene/cache change, so the Viewport subscribes
 * here to repaint when a decode lands or the bitmap is dropped (same role as
 * `useCacheVersionStore`). `missing` mirrors `useSourceMissingStore`: the
 * source couldn't be re-decoded, the scene keeps its `sourcePath` verbatim
 * and the compositor just draws nothing.
 */
interface BackgroundSourceState {
  version: number;
  missing: boolean;
  bump: () => void;
  setMissing: (missing: boolean) => void;
}

export const useBackgroundSourceStore = create<BackgroundSourceState>((set) => ({
  version: 0,
  missing: false,
  bump: () => set((s) => ({ version: s.version + 1 })),
  setMissing: (missing) => set((s) => (s.missing === missing ? s : { ...s, missing })),
}));

function closeBitmap(bitmap: (ImageBitmap & Closable) | undefined): void {
  bitmap?.close?.();
}

/**
 * The decoded bitmap for `sourcePath`, or `undefined` while the decode is
 * pending / failed / for a different path. Keying the read on the path means
 * a stale bitmap can never paint under a scene that has moved to another
 * image — "draws nothing, not stale content".
 */
export function get(sourcePath: string): ImageBitmap | undefined {
  return held && held.sourcePath === sourcePath ? held.bitmap : undefined;
}

/** The path currently held, if any (tests / reconcile). */
export function heldPath(): string | undefined {
  return held?.sourcePath;
}

/** Hold a freshly decoded bitmap, closing whatever it replaces. */
export function set(sourcePath: string, bitmap: ImageBitmap): void {
  if (held && held.bitmap !== bitmap) closeBitmap(held.bitmap);
  held = { bitmap, sourcePath };
  wanted = sourcePath;
  const state = useBackgroundSourceStore.getState();
  state.setMissing(false);
  state.bump();
}

/** Drop and close the held bitmap (none/colour chosen, new project). */
export function clear(): void {
  wanted = undefined;
  const hadHeld = held !== undefined;
  closeBitmap(held?.bitmap);
  held = undefined;
  const state = useBackgroundSourceStore.getState();
  state.setMissing(false);
  if (hadHeld) state.bump();
}

/** Local minimal fs/decode edge, same shape as `HistoryRehydrateDeps` (scene/ must not import project/). */
export interface BackgroundDecodeDeps {
  readFile: (path: string) => Promise<Uint8Array>;
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number } & Closable>;
}

/**
 * Make the holder match `background`: the one routine undo/redo and project
 * load share. A non-image background drops the holder; an image background
 * whose path is already held is left alone; otherwise the old bitmap is
 * dropped now (never paint the wrong image while decoding) and the new one is
 * decoded. An unreadable source never throws — it flags `missing`, keeping the
 * scene's `sourcePath` verbatim, exactly like a missing pixel-node source.
 */
export async function reconcile(
  background: SceneBackground | undefined,
  deps: BackgroundDecodeDeps,
): Promise<void> {
  if (background?.type !== 'image') {
    clear();
    return;
  }
  const path = background.sourcePath;
  if (held?.sourcePath === path) {
    wanted = path;
    useBackgroundSourceStore.getState().setMissing(false);
    return;
  }
  clear();
  wanted = path;
  try {
    const bitmap = (await deps.decode(await deps.readFile(path))) as ImageBitmap;
    if (wanted !== path) {
      closeBitmap(bitmap); // superseded while decoding
      return;
    }
    set(path, bitmap);
  } catch {
    if (wanted === path) useBackgroundSourceStore.getState().setMissing(true);
  }
}
