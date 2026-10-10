/**
 * Refusal by construction (Epic 21 story 1, "Behaviour"): while rhizome holds the document,
 * every scene-writing store action that hasn't moved yet says so with a toast and does
 * nothing. Doing it locally would drift from rhizome silently.
 *
 * Default-deny: the refused set is every function on the store minus the actions rhizome
 * carries (`ON_RHIZOME`) and the internal ones (`INTERNAL`), computed from the store itself,
 * so an action added to `store.ts` later is refused until someone moves it.
 */
import type { SnackbarOptions } from '@preset.nz/ux-kit';
import type { useSceneStore } from '@/scene/store';

type Store = typeof useSceneStore;
type State = ReturnType<Store['getState']>;

/** The actions rhizome carries: `rhizome.ts` replaces them with command-sending versions. */
export const ON_RHIZOME = [
  'setNodeTransform',
  'setNodeProp',
  'setDocumentSize',
  'addPixelNode',
  'addVectorNode',
  'addTextNode',
  'setTextProps',
  'setPixelSource',
  'removeNode',
  'reorderNode',
  'duplicateNode',
  'addModifier',
  'removeModifier',
  'reorderModifier',
  'setModifierParam',
  'setModifierEnabled',
  'setModifierVectorMask',
  'removeModifierMask',
  'setMaskSpace',
  'applyMarqueeAsVectorMask',
] as const;

/** Bookkeeping, not edits: cook state, and whole-scene swaps from rhizome's own restore/open. */
export const INTERNAL = ['markDirty', 'clearDirty', 'loadScene', 'resetScene'] as const;

/** Every function on the store: its actions. */
export function actionNames(state: State): string[] {
  return Object.entries(state)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k);
}

/** The store's actions that this story refuses. */
export function refusedActions(state: State): string[] {
  const kept = new Set<string>([...ON_RHIZOME, ...INTERNAL]);
  return actionNames(state).filter((name) => !kept.has(name));
}

let refusedNow = new Set<string>();

/**
 * True while the refusal wrapper is installed and `name` is one of the refused actions. For a
 * caller that does something outside the scene before its store action (swaps a bitmap), so
 * it can bail out before, not after.
 */
export const isRefused = (name: string): boolean => refusedNow.has(name);

/** `removeNode` -> "Remove node". */
export function actionLabel(name: string): string {
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface RefusalDeps {
  notify: (options: SnackbarOptions) => void;
  /** Milliseconds; a slider scrub fires its action per pointermove, so one toast per window. */
  now?: () => number;
}

const TOAST_WINDOW_MS = 2000;

const isAsync = (f: unknown): boolean =>
  (f as { constructor?: { name?: string } })?.constructor?.name === 'AsyncFunction';

/**
 * Replaces each refused action with one that toasts and returns what a no-op would: a resolved
 * promise for an async action (callers chain on it), `undefined` otherwise. Returns the
 * function that puts the originals back.
 */
export function installRefusals(store: Store, deps: RefusalDeps): () => void {
  const now = deps.now ?? (() => Date.now());
  const state = store.getState();
  const originals: Record<string, unknown> = {};
  const refusing: Record<string, unknown> = {};
  const lastToast = new Map<string, number>();
  for (const name of refusedActions(state)) {
    const own = (state as unknown as Record<string, unknown>)[name];
    originals[name] = own;
    refusing[name] = (..._args: unknown[]) => {
      const t = now();
      const last = lastToast.get(name);
      if (last === undefined || t - last >= TOAST_WINDOW_MS) {
        lastToast.set(name, t);
        deps.notify({ kind: 'warning', message: `${actionLabel(name)} isn't on rhizome yet` });
      }
      return isAsync(own) ? Promise.resolve() : undefined;
    };
  }
  store.setState(refusing as Partial<State>);
  refusedNow = new Set(Object.keys(refusing));
  return () => {
    refusedNow = new Set();
    store.setState(originals as Partial<State>);
  };
}
