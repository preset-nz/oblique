import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneStore } from '@/scene/store';
import {
  actionLabel,
  actionNames,
  INTERNAL,
  installRefusals,
  isRefused,
  ON_RHIZOME,
  refusedActions,
} from './refusal';

const originals = { ...useSceneStore.getState() };
let uninstall: (() => void) | null = null;
let clock = 0;
const notify = vi.fn();

beforeEach(() => {
  notify.mockClear();
  clock = 0;
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

/** Each call is far enough from the last for a toast of its own. */
const install = () => {
  uninstall = installRefusals(useSceneStore, { notify, now: () => (clock += 10_000) });
};

/**
 * Default-deny needs an action that has not moved. Nothing on the store is refused today (Epic
 * 21 story 6), so these tests put two stand-ins on the real store, one sync and one async, and
 * take them off again.
 */
const standIns = { notYetMoved: () => undefined, notYetMovedAsync: async () => undefined };
type WithStandIns = typeof standIns & Record<string, unknown>;

const addStandIns = () => useSceneStore.setState(standIns as never);
const removeStandIns = () => {
  const {
    notYetMoved: _a,
    notYetMovedAsync: _b,
    ...rest
  } = useSceneStore.getState() as unknown as Record<string, unknown>;
  useSceneStore.setState(rest as never, true);
};

describe('refusal by construction', () => {
  it('refuses nothing today: every action on the store has moved to rhizome (Epic 21 story 6)', () => {
    expect(refusedActions(useSceneStore.getState())).toEqual([]);
  });

  it('classifies every action on the store: carried, internal, or refused', () => {
    const all = actionNames(useSceneStore.getState());
    const refused = refusedActions(useSceneStore.getState());
    expect([...refused, ...ON_RHIZOME, ...INTERNAL].sort()).toEqual([...all].sort());
    // a typo in either list would quietly refuse nothing
    for (const name of [...ON_RHIZOME, ...INTERNAL]) expect(all).toContain(name);
    // the layer edits moved in Epic 21 story 3, the modifiers and masks in story 4, the path
    // edits, the fill rule and Convert to Outlines in story 5, the document and lock in story 6
    for (const name of [
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
      'setVectorPaths',
      'setVectorFillRule',
      'convertTextToOutlines',
      'setBackgroundColor',
      'setBackgroundImage',
      'setNote',
      'lockNode',
      'unlockNode',
    ]) {
      expect(refused).not.toContain(name);
      expect(ON_RHIZOME).toContain(name);
    }
  });

  it('installing with nothing to refuse changes no action', () => {
    install();
    const now = useSceneStore.getState() as unknown as Record<string, unknown>;
    for (const name of actionNames(useSceneStore.getState())) {
      expect(now[name], name).toBe((originals as unknown as Record<string, unknown>)[name]);
    }
  });

  describe('default-deny: an action added to the store and not moved', () => {
    beforeEach(addStandIns);
    afterEach(() => {
      uninstall?.();
      uninstall = null;
      removeStandIns();
    });

    it('is on the refused list, and nothing else is', () => {
      expect(refusedActions(useSceneStore.getState()).sort()).toEqual([
        'notYetMoved',
        'notYetMovedAsync',
      ]);
    });

    it('is refused with a toast, and changes nothing', async () => {
      install();
      const state = useSceneStore.getState() as unknown as WithStandIns;
      const before = useSceneStore.getState().scene;
      for (const name of ['notYetMoved', 'notYetMovedAsync'] as const) {
        notify.mockClear();
        expect(state[name], name).not.toBe(standIns[name]);
        const out = (state[name] as (...a: unknown[]) => unknown)('a', 'b');
        if (out instanceof Promise) await out;
        expect(notify, name).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0], name).toMatchObject({ kind: 'warning' });
        expect(notify.mock.calls[0][0].message, name).toMatch(/ isn't on rhizome yet$/);
        expect(useSceneStore.getState().scene, name).toBe(before);
      }
    });

    it('leaves the carried and internal actions as they were', () => {
      install();
      const state = useSceneStore.getState() as unknown as Record<string, unknown>;
      for (const name of [...ON_RHIZOME, ...INTERNAL]) {
        expect(state[name], name).toBe((originals as unknown as Record<string, unknown>)[name]);
      }
    });

    it('answers an async action with a resolved promise, since callers chain on it', async () => {
      install();
      const state = useSceneStore.getState() as unknown as WithStandIns;
      const out = (state.notYetMovedAsync as () => Promise<void>)();
      expect(out).toBeInstanceOf(Promise);
      await expect(out).resolves.toBeUndefined();
      expect((state.notYetMoved as () => void)()).toBeUndefined();
    });

    it('puts the originals back', () => {
      install();
      uninstall?.();
      uninstall = null;
      const state = useSceneStore.getState() as unknown as WithStandIns;
      expect(state.notYetMoved).toBe(standIns.notYetMoved);
      expect(state.notYetMovedAsync).toBe(standIns.notYetMovedAsync);
    });

    it('toasts once per action per window, so a scrub does not flood', () => {
      let t = 0;
      uninstall = installRefusals(useSceneStore, { notify, now: () => t });
      const { notYetMoved } = useSceneStore.getState() as unknown as WithStandIns;
      notYetMoved();
      t = 500;
      notYetMoved();
      expect(notify).toHaveBeenCalledTimes(1);
      t = 3000;
      notYetMoved();
      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('says which actions are refused, only while installed', () => {
      expect(isRefused('notYetMoved')).toBe(false);
      install();
      expect(isRefused('notYetMoved')).toBe(true);
      expect(isRefused('setNote')).toBe(false); // on rhizome since Epic 21 story 6
      expect(isRefused('setPixelSource')).toBe(false); // since story 2
      expect(isRefused('setNodeTransform')).toBe(false);
      uninstall?.();
      uninstall = null;
      expect(isRefused('notYetMoved')).toBe(false);
    });
  });

  it('names an action in words', () => {
    expect(actionLabel('lockNode')).toBe('Lock node');
    expect(actionLabel('setVectorFillRule')).toBe('Set vector fill rule');
  });
});
