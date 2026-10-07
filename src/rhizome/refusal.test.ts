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

describe('refusal by construction', () => {
  it('classifies every action on the store: carried, internal, or refused', () => {
    const all = actionNames(useSceneStore.getState());
    const refused = refusedActions(useSceneStore.getState());
    expect([...refused, ...ON_RHIZOME, ...INTERNAL].sort()).toEqual([...all].sort());
    // a typo in either list would quietly refuse nothing
    for (const name of [...ON_RHIZOME, ...INTERNAL]) expect(all).toContain(name);
    for (const name of ['removeNode', 'addModifier', 'lockNode', 'setBackgroundColor']) {
      expect(refused).toContain(name);
    }
  });

  it('refuses every scene-writing action that is not carried, with a toast, and changes nothing', async () => {
    install();
    const state = useSceneStore.getState();
    const before = state.scene;
    const refused = refusedActions(originals as never);
    expect(refused.length).toBeGreaterThan(10);
    for (const name of refused) {
      notify.mockClear();
      const call = (state as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
      expect(call, name).not.toBe((originals as unknown as Record<string, unknown>)[name]);
      const out = call('a', 'b', 'c', 'd');
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
    const out = useSceneStore.getState().lockNode('a', async () => ({}) as ImageBitmap);
    expect(out).toBeInstanceOf(Promise);
    await expect(out).resolves.toBeUndefined();
  });

  it('puts the originals back', () => {
    install();
    uninstall?.();
    uninstall = null;
    expect(useSceneStore.getState().removeNode).toBe(originals.removeNode);
  });

  it('toasts once per action per window, so a scrub does not flood', () => {
    let t = 0;
    uninstall = installRefusals(useSceneStore, { notify, now: () => t });
    const { setNote } = useSceneStore.getState();
    setNote('a');
    t = 500;
    setNote('b');
    expect(notify).toHaveBeenCalledTimes(1);
    t = 3000;
    setNote('c');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('says which actions are refused, only while installed', () => {
    expect(isRefused('setNote')).toBe(false);
    install();
    expect(isRefused('setNote')).toBe(true);
    expect(isRefused('setPixelSource')).toBe(false); // on rhizome since Epic 21 story 2
    expect(isRefused('setNodeTransform')).toBe(false);
    uninstall?.();
    uninstall = null;
    expect(isRefused('setNote')).toBe(false);
  });

  it('names an action in words', () => {
    expect(actionLabel('removeNode')).toBe('Remove node');
    expect(actionLabel('setModifierVectorMask')).toBe('Set modifier vector mask');
  });
});
