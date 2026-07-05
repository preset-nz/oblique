import { readFile } from '@tauri-apps/plugin-fs';
import * as cache from '@/scene/cache';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import {
  isPixelNode,
  isVectorNode,
  type PixelNode,
  type Scene,
  type SceneNode,
} from '@/scene/types';
import { sceneChangedIgnoringDirty } from './sceneDiff';

/**
 * Undo/history (Epic 13). Snapshot model, not command pattern: the undo/redo
 * stacks hold plain `Scene` references. Because the scene store updates
 * immutably (every mutator returns a new `scene` object via spread), a past
 * `Scene` reference is never mutated in place — pushing it onto a stack is
 * free (structural sharing), no serialisation, no deltas (architecture.md,
 * epic scope sketch).
 *
 * Instrumentation choice: a single `useSceneStore.subscribe` at module scope
 * (same always-on pattern as `project/io.ts`'s `markMutated` subscription)
 * rather than wrapping every named store action individually. Every scene
 * mutation already funnels through this one subscription point, so it can't
 * miss a mutation path the way wrapping call-sites one-by-one could — the
 * risk the story flagged. Two guards keep it from over-capturing:
 *
 * 1. Dirty-only changes (the cook scheduler's `clearDirty` after every cook,
 *    `markDirty` on project load) are filtered out — see
 *    `sceneChangedIgnoringDirty`. They are not user actions; Cmd+Z must never
 *    "undo" a cache becoming clean.
 * 2. Scrub-drags (InputNumber, the opacity slider) wrap their whole drag in
 *    `beginTransaction`/`endTransaction` so every intermediate `onChange`
 *    during one drag coalesces into a single undo step, per the story's
 *    transaction-boundary rule.
 */

const CAP = 50;

let undoStack: Scene[] = [];
let redoStack: Scene[] = [];

let transactionActive = false;
let transactionBefore: Scene | null = null;

/** True while `restoreScene` is applying an undo/redo — the subscription must not re-capture its own restore as a new undo step. */
let suppressCapture = false;

// Real-edit-vs-cook-churn test lives in scene/sceneDiff.ts (shared with the
// cook scheduler, which must not reset its idle timers on dirty-flag churn).

function pushUndo(scene: Scene): void {
  undoStack.push(scene);
  if (undoStack.length > CAP) undoStack.shift();
  redoStack = [];
}

/** Test-only / load-time reset: drops both stacks and any open transaction. */
export function clear(): void {
  undoStack = [];
  redoStack = [];
  transactionActive = false;
  transactionBefore = null;
  suppressCapture = false;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

function flushTransaction(): void {
  const before = transactionBefore;
  transactionActive = false;
  transactionBefore = null;
  if (!before) return;
  const current = useSceneStore.getState().scene;
  if (sceneChangedIgnoringDirty(before, current)) {
    pushUndo(before);
  }
}

/**
 * Marks the start of one coalesced undo step (a scrub-drag). Captures the
 * pre-drag scene; every mutation until `endTransaction` collapses into that
 * one step. Self-heals an unmatched previous `beginTransaction` (e.g. a
 * pointer-cancel that never reached its `endTransaction` call) by flushing
 * it first, so a missed release can never wedge history shut.
 */
export function beginTransaction(): void {
  if (transactionActive) flushTransaction();
  transactionActive = true;
  transactionBefore = useSceneStore.getState().scene;
}

/** Marks the end of a coalesced undo step. No-op if no transaction is open. */
export function endTransaction(): void {
  if (!transactionActive) return;
  flushTransaction();
}

useSceneStore.subscribe((state, prev) => {
  if (state.scene === prev.scene) return;
  if (suppressCapture) return; // our own undo/redo restore, not a user action
  if (!sceneChangedIgnoringDirty(prev.scene, state.scene)) return; // cook churn only
  if (transactionActive) return; // coalesced at endTransaction/flushTransaction
  pushUndo(prev.scene);
});

/**
 * File-system edge injected for tests, same pattern as `project/import.ts`'s
 * `ImportDeps` — kept as a local, minimal shape (rather than importing
 * `project/import.ts`) so `scene/` doesn't depend on `project/`.
 */
export interface HistoryRehydrateDeps {
  readFile: (path: string) => Promise<Uint8Array>;
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number } & sources.Closable>;
}

async function realDecode(
  bytes: Uint8Array,
): Promise<{ width: number; height: number } & sources.Closable> {
  const blob = new Blob([bytes as BlobPart]);
  return createImageBitmap(blob);
}

export const productionRehydrateDeps: HistoryRehydrateDeps = {
  readFile: (path) => readFile(path),
  decode: realDecode,
};

/**
 * Cook-affecting fields only (dirty rule 4): modifiers (maskId changes ride
 * along via the modifiers JSON), the mask DEFINITIONS those modifiers
 * reference (same maskId, edited geometry/feather — invisible to the
 * modifiers array, so compared explicitly), (pixel nodes)
 * sourcePath/sourceSize, and (vector nodes) paths/fillRule — a vector node's
 * raster comes entirely from those two fields (vectorRasterize.ts), so an
 * undo/redo across a path-editing.md edit must register here or
 * `restoreScene` leaves the node clean while a stale cached bitmap (from
 * before/after the edit it's undoing) keeps painting.
 *
 * A mask reference resolves through BOTH tables (cook.ts's
 * `makeRasterizeFor` rule): a baked `MaskDef`, or a `VectorMaskRef` plus
 * the referenced vector node's live paths/fillRule — the referenced
 * GEOMETRY is part of the consumer's cook inputs (vector-modifier-masks.md
 * cross-node dirty), so an undo that only changes the referenced vector
 * node's paths must dirty the consumer too, not just the vector node.
 */
function resolvedMaskInput(maskId: string | undefined, scene: Scene): unknown {
  if (!maskId) return null;
  const baked = scene.masks?.[maskId];
  if (baked) return baked;
  const ref = scene.maskRefs?.[maskId];
  if (!ref) return null;
  const target = scene.nodes.find((n) => n.id === ref.nodeId);
  const geometry =
    target && isVectorNode(target) ? { paths: target.paths, fillRule: target.fillRule } : null;
  return { ref, geometry };
}

function cookAffectingChanged(a: SceneNode, b: SceneNode, sceneA: Scene, sceneB: Scene): boolean {
  if (JSON.stringify(a.modifiers) !== JSON.stringify(b.modifiers)) return true;
  const refA = a.modifiers.map((m) => resolvedMaskInput(m.maskId, sceneA));
  const refB = b.modifiers.map((m) => resolvedMaskInput(m.maskId, sceneB));
  if (JSON.stringify(refA) !== JSON.stringify(refB)) return true;
  const pa = isPixelNode(a) ? { sourcePath: a.sourcePath, sourceSize: a.sourceSize } : undefined;
  const pb = isPixelNode(b) ? { sourcePath: b.sourcePath, sourceSize: b.sourceSize } : undefined;
  if (JSON.stringify(pa) !== JSON.stringify(pb)) return true;
  const va = isVectorNode(a) ? { paths: a.paths, fillRule: a.fillRule } : undefined;
  const vb = isVectorNode(b) ? { paths: b.paths, fillRule: b.fillRule } : undefined;
  return JSON.stringify(va) !== JSON.stringify(vb);
}

/**
 * Restores `target` wholesale (per the epic's design), but recomputes every
 * node's `dirty` flag from an old-vs-restored diff rather than trusting
 * `target`'s own frozen flags (which may be stale — already-cleared by a
 * cook that ran after this snapshot was taken, or still-dirty from a cook
 * that hadn't finished yet):
 *
 * - Node absent from `current` (undo-of-delete / redo-of-add): the source
 *   bitmap was evicted by `deleteNode` — re-decode it from `sourcePath`
 *   (same contract as `project/import.ts`'s project-load re-hydration)
 *   before the scheduler's next cook can find it, then mark dirty.
 * - Node present in both with changed modifiers/sourcePath/sourceSize: mark
 *   dirty (recook).
 * - Node present in both, unchanged cook-affecting fields: leave clean —
 *   pure compositing fields (visible/opacity/blendMode/order) never dirty
 *   per dirty rule 4.
 * - Node present in `current` but absent from `target` (undo-of-add /
 *   redo-of-delete): evict its cache + decoded source so nothing leaks.
 */
async function restoreScene(
  current: Scene,
  target: Scene,
  deps: HistoryRehydrateDeps,
): Promise<void> {
  const currentById = new Map(current.nodes.map((n) => [n.id, n]));
  const targetById = new Map(target.nodes.map((n) => [n.id, n]));

  for (const id of currentById.keys()) {
    if (!targetById.has(id)) {
      cache.clearNode(id);
      sources.remove(id);
    }
  }

  await Promise.all(
    target.nodes
      .filter((node): node is PixelNode => isPixelNode(node) && !sources.get(node.id))
      .map(async (node) => {
        try {
          const bytes = await deps.readFile(node.sourcePath);
          const bitmap = await deps.decode(bytes);
          sources.set(node.id, bitmap as ImageBitmap);
          sources.useSourceMissingStore.getState().clear(node.id);
        } catch {
          // sourcePath kept verbatim — paintScene's striped placeholder covers this,
          // same re-hydration contract as project load.
          sources.useSourceMissingStore.getState().setMissing(node.id, true);
        }
      }),
  );

  const nodes = target.nodes.map((node) => {
    const previous = currentById.get(node.id);
    const dirty =
      !previous || cookAffectingChanged(previous, node, current, target)
        ? { draft: true, working: true }
        : { draft: false, working: false };
    return { ...node, dirty };
  });

  suppressCapture = true;
  try {
    useSceneStore.getState().loadScene({ ...target, nodes });
  } finally {
    suppressCapture = false;
  }
}

/** Cmd+Z. No-op with an empty undo stack. Flushes any open transaction first. */
export async function undo(deps: HistoryRehydrateDeps = productionRehydrateDeps): Promise<void> {
  if (transactionActive) flushTransaction();
  const target = undoStack.pop();
  if (!target) return;
  const current = useSceneStore.getState().scene;
  redoStack.push(current);
  if (redoStack.length > CAP) redoStack.shift();
  await restoreScene(current, target, deps);
}

/** Shift+Cmd+Z. No-op with an empty redo stack. Flushes any open transaction first. */
export async function redo(deps: HistoryRehydrateDeps = productionRehydrateDeps): Promise<void> {
  if (transactionActive) flushTransaction();
  const target = redoStack.pop();
  if (!target) return;
  const current = useSceneStore.getState().scene;
  undoStack.push(current);
  if (undoStack.length > CAP) undoStack.shift();
  await restoreScene(current, target, deps);
}
