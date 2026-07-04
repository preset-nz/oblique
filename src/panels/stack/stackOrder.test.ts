import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from '@/scene/store';
import type { Modifier, PixelNode } from '@/scene/types';
import { invertIndex, nudgeDisplayIndex, nudgeModelIndex, toDisplayOrder } from './stackOrder';

describe('toDisplayOrder', () => {
  it('reverses model order into bottom-to-top display order', () => {
    // Model order [invert, levels, grain]: invert applies first (bottom),
    // grain applies last (top). Displayed top-to-bottom reads [grain,
    // levels, invert] — last-applied first in the rendered list.
    expect(toDisplayOrder(['invert', 'levels', 'grain'])).toEqual(['grain', 'levels', 'invert']);
  });

  it('is its own inverse (reversing twice restores model order)', () => {
    const model = ['a', 'b', 'c', 'd'];
    expect(toDisplayOrder(toDisplayOrder(model))).toEqual(model);
  });

  it('handles empty and single-element stacks', () => {
    expect(toDisplayOrder([])).toEqual([]);
    expect(toDisplayOrder(['only'])).toEqual(['only']);
  });
});

describe('invertIndex', () => {
  it('maps model index 0 (first-applied) to the last display index (bottom row)', () => {
    expect(invertIndex(0, 3)).toBe(2);
  });

  it('maps the last model index (last-applied) to display index 0 (top row)', () => {
    expect(invertIndex(2, 3)).toBe(0);
  });

  it('is self-inverse: inverting twice returns the original index', () => {
    for (let i = 0; i < 5; i++) {
      expect(invertIndex(invertIndex(i, 5), 5)).toBe(i);
    }
  });
});

describe('nudgeDisplayIndex', () => {
  it('moving up decreases display index (toward the displayed top)', () => {
    expect(nudgeDisplayIndex(1, 'up', 3)).toBe(0);
  });

  it('moving down increases display index (toward the displayed bottom)', () => {
    expect(nudgeDisplayIndex(1, 'down', 3)).toBe(2);
  });

  it('is null at the top edge moving up', () => {
    expect(nudgeDisplayIndex(0, 'up', 3)).toBeNull();
  });

  it('is null at the bottom edge moving down', () => {
    expect(nudgeDisplayIndex(2, 'down', 3)).toBeNull();
  });
});

describe('nudgeModelIndex — the flip-undo risk spot', () => {
  // 3-modifier stack, model order [invert, levels, grain] (invert first-
  // applied/bottom, grain last-applied/top). Displayed top-to-bottom:
  // [grain(d0), levels(d1), invert(d2)].
  const length = 3;

  it('nudging the top displayed row (grain, d0) up is a no-op (already at the top/last-applied end)', () => {
    expect(nudgeModelIndex(0, 'up', length)).toBeNull();
  });

  it('nudging the bottom displayed row (invert, d2) down is a no-op (already first-applied)', () => {
    expect(nudgeModelIndex(2, 'down', length)).toBeNull();
  });

  it('nudging the middle row (levels, d1) up moves it later in application order (model index increases)', () => {
    // levels is model index 1; nudging its display row up should swap it
    // above grain in application order -> model index 2 (applies last).
    expect(nudgeModelIndex(1, 'up', length)).toBe(2);
  });

  it('nudging the middle row (levels, d1) down moves it earlier in application order (model index decreases)', () => {
    // Nudging down should swap it below invert in application order ->
    // model index 0 (applies first).
    expect(nudgeModelIndex(1, 'down', length)).toBe(0);
  });

  it('nudging the bottom displayed row (invert, d2) up moves it one step later (model index increases by one)', () => {
    // invert is model index 0; moving its display row up one step should
    // land it at model index 1 (now applies second, after levels).
    expect(nudgeModelIndex(2, 'up', length)).toBe(1);
  });

  it('nudging the top displayed row (grain, d0) down moves it one step earlier (model index decreases by one)', () => {
    // grain is model index 2; moving its display row down one step should
    // land it at model index 1 (now applies second, before invert... i.e.
    // second-to-last).
    expect(nudgeModelIndex(0, 'down', length)).toBe(1);
  });

  it('order-dependent pair round-trips: invert-then-levels reversed is levels-then-invert', () => {
    // Concrete acceptance scenario: a 2-modifier stack [invert, levels]
    // (invert first). Nudging the top displayed row (levels, d0) down
    // should swap application order to [levels, invert].
    const pairLength = 2;
    expect(nudgeModelIndex(0, 'down', pairLength)).toBe(0);
    expect(nudgeModelIndex(1, 'up', pairLength)).toBe(1);
  });
});

// The acceptance criterion isn't just "the index math is right in
// isolation" — it's that composing `nudgeModelIndex` with the real
// `reorderModifier` store action, on a real node, produces the correct
// resulting DISPLAY order. This exercises that full round trip: seed a
// node, nudge a display row, and check `toDisplayOrder(node.modifiers)`
// against the expected reading.
describe('nudgeModelIndex composed with reorderModifier — full round trip', () => {
  function pixelNode(id: string, modifiers: Modifier[]): PixelNode {
    return {
      id,
      label: 'Layer',
      type: 'pixel',
      state: 'active',
      output: 'image',
      cameraId: null,
      modifiers,
      visible: true,
      blendMode: 'normal',
      opacity: 1,
      dirty: { draft: false, working: false },
      sourcePath: '/tmp/a.png',
      sourceSize: [100, 100],
    };
  }

  function modifier(type: string): Modifier {
    return { id: `mod-${type}`, type, enabled: true, params: {} };
  }

  beforeEach(() => {
    useSceneStore.setState({
      scene: {
        id: 'scene-1',
        nodes: [],
        cameras: [],
        defaultCameraId: null,
        resolution: 'working',
        documentSize: [0, 0],
      },
    });
  });

  function currentTypes(nodeId: string): string[] {
    const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
    return toDisplayOrder(node?.modifiers ?? []).map((m) => m.type);
  }

  it('order-dependent pair: nudging the displayed-top row down swaps invert/levels reading', () => {
    const node = pixelNode('n1', [modifier('invert'), modifier('levels')]);
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [node] } }));

    // Model [invert, levels] -> display [levels(d0, top), invert(d1, bottom)].
    expect(currentTypes('n1')).toEqual(['levels', 'invert']);

    const target = nudgeModelIndex(0, 'down', 2); // levels' displayed row, moving down
    expect(target).not.toBeNull();
    useSceneStore.getState().reorderModifier('n1', 'mod-levels', target as number);

    // Now applies [levels, invert] -> display top-to-bottom [invert, levels].
    expect(currentTypes('n1')).toEqual(['invert', 'levels']);
  });

  it('3-modifier stack: nudging the middle displayed row up moves it toward last-applied', () => {
    const node = pixelNode('n2', [modifier('invert'), modifier('levels'), modifier('grain')]);
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [node] } }));

    // Model [invert, levels, grain] -> display [grain(d0), levels(d1), invert(d2)].
    expect(currentTypes('n2')).toEqual(['grain', 'levels', 'invert']);

    const target = nudgeModelIndex(1, 'up', 3); // levels' displayed row, moving up
    expect(target).not.toBeNull();
    useSceneStore.getState().reorderModifier('n2', 'mod-levels', target as number);

    // levels now applies last -> displayed at the top.
    expect(currentTypes('n2')).toEqual(['levels', 'grain', 'invert']);
  });
});
