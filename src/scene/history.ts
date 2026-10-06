import type { Scene } from '@/scene/types';
import { type HistoryRehydrateDeps, productionRehydrateDeps, restoreScene } from './restore';
import { sceneChangedIgnoringDirty } from './sceneDiff';
import { useSceneStore } from './store';

export type { HistoryRehydrateDeps };
export { productionRehydrateDeps };

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
 *
 * Epic 21 story 1: when rhizome backs the document (`setHistoryBackend`), this stack is
 * out of the picture. Transactions become rhizome gestures (begin/end/cancel), nothing is
 * captured, and `undo`/`redo` are rhizome's. The hooks are injected so `scene/` doesn't
 * import `rhizome/`.
 */

/** What rhizome supplies in place of the snapshot stacks. */
export interface HistoryBackend {
  begin: () => void;
  end: () => void;
  cancel: () => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

let backend: HistoryBackend | null = null;

/** True while rhizome holds undo: a transaction can then be cancelled, and `cancelTransaction` does something. */
export const hasHistoryBackend = (): boolean => backend !== null;

/** Hands transactions, undo and redo to rhizome (or takes them back with `null`). */
export function setHistoryBackend(next: HistoryBackend | null): void {
  backend = next;
  if (next) clear(); // whatever the snapshot stacks held before is not rhizome's undo
}

const CAP = 50;

let undoStack: Scene[] = [];
let redoStack: Scene[] = [];

let transactionActive = false;
let transactionBefore: Scene | null = null;

/** True while a restore is applying an undo/redo — the subscription must not re-capture its own restore as a new undo step. */
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

/**
 * Run `fn` without its scene mutations becoming undo steps — for bookkeeping
 * the app does by itself (e.g. fitting a node to a file that became readable
 * on Save), never for user edits.
 */
export function withoutCapture(fn: () => void): void {
  const was = suppressCapture;
  suppressCapture = true;
  try {
    fn();
  } finally {
    suppressCapture = was;
  }
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
  if (backend) {
    backend.begin();
    return;
  }
  if (transactionActive) flushTransaction();
  transactionActive = true;
  transactionBefore = useSceneStore.getState().scene;
}

/** Marks the end of a coalesced undo step. No-op if no transaction is open. */
export function endTransaction(): void {
  if (backend) {
    backend.end();
    return;
  }
  if (!transactionActive) return;
  flushTransaction();
}

/**
 * Takes back everything done since `beginTransaction`. Only rhizome can: the snapshot stacks
 * never had it, so without a backend this does nothing.
 */
export function cancelTransaction(): void {
  backend?.cancel();
}

useSceneStore.subscribe((state, prev) => {
  if (backend) return; // rhizome's undo is the only one
  if (state.scene === prev.scene) return;
  if (suppressCapture) return; // our own undo/redo restore, not a user action
  if (!sceneChangedIgnoringDirty(prev.scene, state.scene)) return; // cook churn only
  if (transactionActive) return; // coalesced at endTransaction/flushTransaction
  pushUndo(prev.scene);
});

/** Applies a restored scene with capture off: it is not a user action. */
function restoreApply(scene: Scene): void {
  withoutCapture(() => useSceneStore.getState().loadScene(scene));
}

/** Cmd+Z. No-op with an empty undo stack. Flushes any open transaction first. */
export async function undo(deps: HistoryRehydrateDeps = productionRehydrateDeps): Promise<void> {
  if (backend) return backend.undo();
  if (transactionActive) flushTransaction();
  const target = undoStack.pop();
  if (!target) return;
  const current = useSceneStore.getState().scene;
  redoStack.push(current);
  if (redoStack.length > CAP) redoStack.shift();
  await restoreScene(current, target, deps, restoreApply);
}

/** Shift+Cmd+Z. No-op with an empty redo stack. Flushes any open transaction first. */
export async function redo(deps: HistoryRehydrateDeps = productionRehydrateDeps): Promise<void> {
  if (backend) return backend.redo();
  if (transactionActive) flushTransaction();
  const target = redoStack.pop();
  if (!target) return;
  const current = useSceneStore.getState().scene;
  undoStack.push(current);
  if (undoStack.length > CAP) undoStack.shift();
  await restoreScene(current, target, deps, restoreApply);
}
