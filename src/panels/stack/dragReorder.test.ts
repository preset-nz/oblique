import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from '@/scene/store';
import type { Modifier, PixelNode, SceneNode, VectorNode } from '@/scene/types';
import {
  insertionIndexFor,
  insertionLineY,
  layerDrop,
  layerMoveRealIndex,
  layerMoveTarget,
  layerNodes,
  layerRealIndex,
  moveTarget,
  type RowRect,
} from './dragReorder';
import { invertIndex, toDisplayOrder } from './stackOrder';

// Four 20px rows with 4px gaps: [0,20] [24,44] [48,68] [72,92].
const rects: RowRect[] = [0, 1, 2, 3].map((i) => ({ top: i * 24, bottom: i * 24 + 20 }));

describe('insertionIndexFor', () => {
  it('is 0 above the first row midpoint', () => {
    expect(insertionIndexFor(-50, rects)).toBe(0);
    expect(insertionIndexFor(9, rects)).toBe(0);
  });

  it('flips to the next gap at each row midpoint', () => {
    expect(insertionIndexFor(11, rects)).toBe(1);
    expect(insertionIndexFor(33, rects)).toBe(1);
    expect(insertionIndexFor(35, rects)).toBe(2);
    expect(insertionIndexFor(57, rects)).toBe(2);
    expect(insertionIndexFor(59, rects)).toBe(3);
  });

  it('is n below the last row midpoint', () => {
    expect(insertionIndexFor(81, rects)).toBe(3);
    expect(insertionIndexFor(83, rects)).toBe(4);
    expect(insertionIndexFor(999, rects)).toBe(4);
  });

  it('handles empty and tall rows', () => {
    expect(insertionIndexFor(10, [])).toBe(0);
    expect(insertionIndexFor(50, [{ top: 0, bottom: 200 }])).toBe(0);
    expect(insertionIndexFor(150, [{ top: 0, bottom: 200 }])).toBe(1);
  });
});

describe('moveTarget', () => {
  it('is null for the row own slot (gap above it or directly below it)', () => {
    expect(moveTarget(2, 2)).toBeNull();
    expect(moveTarget(2, 3)).toBeNull();
    expect(moveTarget(0, 0)).toBeNull();
    expect(moveTarget(3, 4)).toBeNull();
  });

  it('moving up: the gap index is the target', () => {
    expect(moveTarget(3, 0)).toBe(0);
    expect(moveTarget(3, 2)).toBe(2);
  });

  it('moving down: removing the row first shifts the target up by one', () => {
    expect(moveTarget(0, 4)).toBe(3);
    expect(moveTarget(0, 2)).toBe(1);
    expect(moveTarget(1, 3)).toBe(2);
  });
});

describe('insertionLineY', () => {
  it('sits flush with the outer edges at the ends and mid-gap between rows', () => {
    expect(insertionLineY(0, rects)).toBe(0);
    expect(insertionLineY(1, rects)).toBe(22);
    expect(insertionLineY(3, rects)).toBe(70);
    expect(insertionLineY(4, rects)).toBe(92);
  });

  it('is null for an empty list', () => {
    expect(insertionLineY(0, [])).toBeNull();
  });
});

describe('layerMoveTarget (Layer menu)', () => {
  it('forward / backward step one slot; index 0 is the top', () => {
    expect(layerMoveTarget(2, 4, 'forward')).toBe(1);
    expect(layerMoveTarget(2, 4, 'backward')).toBe(3);
  });

  it('front / back jump to the ends', () => {
    expect(layerMoveTarget(2, 4, 'front')).toBe(0);
    expect(layerMoveTarget(2, 4, 'back')).toBe(3);
  });

  it('no-ops at the stack edges', () => {
    expect(layerMoveTarget(0, 4, 'forward')).toBeNull();
    expect(layerMoveTarget(0, 4, 'front')).toBeNull();
    expect(layerMoveTarget(3, 4, 'backward')).toBeNull();
    expect(layerMoveTarget(3, 4, 'back')).toBeNull();
    expect(layerMoveTarget(0, 1, 'forward')).toBeNull();
  });

  it('no-ops for an out-of-range index (no selection found)', () => {
    expect(layerMoveTarget(-1, 4, 'front')).toBeNull();
    expect(layerMoveTarget(4, 4, 'back')).toBeNull();
  });
});

function pixelNode(id: string, modifiers: Modifier[] = []): PixelNode {
  return {
    id,
    label: id,
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

function seed(nodes: PixelNode[]) {
  useSceneStore.setState({
    scene: {
      id: 'scene-1',
      nodes,
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [0, 0],
    },
  });
}

function nodeById(id: string) {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

/**
 * What StackPanel does on a drop: a display-index drag (from, gap) becomes a
 * display toIndex via moveTarget, then a model index via invertIndex.
 */
function dropModifier(nodeId: string, fromDisplay: number, gap: number) {
  const node = nodeById(nodeId);
  const to = moveTarget(fromDisplay, gap);
  if (to === null) return false;
  const mod = toDisplayOrder(node.modifiers)[fromDisplay];
  useSceneStore.getState().reorderModifier(nodeId, mod.id, invertIndex(to, node.modifiers.length));
  return true;
}

const displayTypes = (nodeId: string) =>
  toDisplayOrder(nodeById(nodeId).modifiers).map((m) => m.type);

describe('modifier drop: display -> model round trip with the real store', () => {
  beforeEach(() => {
    seed([]);
  });

  it('dragging the bottom (first-applied) row to the top makes it the last applied', () => {
    seed([pixelNode('n1', [modifier('invert'), modifier('levels'), modifier('grain')])]);
    // Display top-to-bottom: [grain, levels, invert]. Grab invert (d2), drop in gap 0.
    expect(displayTypes('n1')).toEqual(['grain', 'levels', 'invert']);
    expect(dropModifier('n1', 2, 0)).toBe(true);
    expect(nodeById('n1').modifiers.map((m) => m.type)).toEqual(['levels', 'grain', 'invert']);
    expect(displayTypes('n1')).toEqual(['invert', 'grain', 'levels']);
    expect(nodeById('n1').dirty).toEqual({ draft: true, working: true });
  });

  it('dragging the top (last-applied) row to the bottom makes it first applied', () => {
    seed([pixelNode('n1', [modifier('invert'), modifier('levels'), modifier('grain')])]);
    expect(dropModifier('n1', 0, 3)).toBe(true);
    expect(nodeById('n1').modifiers.map((m) => m.type)).toEqual(['grain', 'invert', 'levels']);
  });

  it('dropping into a middle gap matches what the indicator showed', () => {
    seed([pixelNode('n1', [modifier('invert'), modifier('levels'), modifier('grain')])]);
    // Grab grain (d0), drop in the gap between levels (d1) and invert (d2): gap 2.
    expect(dropModifier('n1', 0, 2)).toBe(true);
    expect(displayTypes('n1')).toEqual(['levels', 'grain', 'invert']);
  });

  it('own-slot drops write nothing', () => {
    seed([pixelNode('n1', [modifier('invert'), modifier('levels')])]);
    const before = useSceneStore.getState().scene;
    expect(dropModifier('n1', 1, 1)).toBe(false);
    expect(dropModifier('n1', 1, 2)).toBe(false);
    expect(useSceneStore.getState().scene).toBe(before);
  });
});

describe('layer drop with the real store', () => {
  beforeEach(() => {
    seed([pixelNode('a'), pixelNode('b'), pixelNode('c'), pixelNode('d')]);
  });

  it('dragging layer 3 above layer 0 makes it the top node', () => {
    const to = moveTarget(3, 0);
    expect(to).toBe(0);
    useSceneStore.getState().reorderNode('d', to as number);
    expect(useSceneStore.getState().scene.nodes.map((n) => n.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('Layer menu targets drive reorderNode to the right order', () => {
    const store = useSceneStore.getState();
    store.reorderNode('c', layerMoveTarget(2, 4, 'front') as number);
    expect(useSceneStore.getState().scene.nodes.map((n) => n.id)).toEqual(['c', 'a', 'b', 'd']);
    useSceneStore.getState().reorderNode('c', layerMoveTarget(0, 4, 'back') as number);
    expect(useSceneStore.getState().scene.nodes.map((n) => n.id)).toEqual(['a', 'b', 'd', 'c']);
  });
});

function selectionNode(id: string): VectorNode {
  return {
    ...pixelNode(id),
    type: 'vector',
    visible: false,
    role: 'selection',
    paths: [],
    fillRule: 'nonzero',
  } as unknown as VectorNode;
}

const ids = (nodes: readonly SceneNode[]) => nodes.map((n) => n.id);
const sceneIds = () => ids(useSceneStore.getState().scene.nodes);

/** What LayerList does on a drop: display indices in, one `reorderNode` with the real index out. */
function dropLayer(fromDisplay: number, gap: number) {
  const to = moveTarget(fromDisplay, gap);
  if (to === null) return false;
  const drop = layerDrop(useSceneStore.getState().scene.nodes, fromDisplay, to);
  if (!drop) return false;
  useSceneStore.getState().reorderNode(drop.id, drop.toIndex);
  return true;
}

describe('layer list with saved selections in the stack (selections-panel.md)', () => {
  // Real order: s0 a s1 b c s2 d. The list shows a b c d.
  const nodes = () => [
    selectionNode('s0'),
    pixelNode('a'),
    selectionNode('s1'),
    pixelNode('b'),
    pixelNode('c'),
    selectionNode('s2'),
    pixelNode('d'),
  ];

  beforeEach(() => {
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: nodes() } }));
  });

  it('layerNodes hides the selection nodes', () => {
    expect(ids(layerNodes(nodes()))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('layerRealIndex maps a display slot to the real index of the layer there', () => {
    const all = nodes();
    expect([0, 1, 2, 3].map((i) => layerRealIndex(all, i))).toEqual([1, 3, 4, 6]);
    expect(layerRealIndex(all, 4)).toBeNull();
    expect(layerRealIndex(all, -1)).toBeNull();
  });

  it('dragging a layer up lands it just above the layer it was dropped on', () => {
    // d (display 3) dropped in gap 1: between a and b
    expect(dropLayer(3, 1)).toBe(true);
    expect(sceneIds()).toEqual(['s0', 'a', 's1', 'd', 'b', 'c', 's2']);
  });

  it('dragging a layer down lands it just below the layer it was dropped on', () => {
    // a (display 0) dropped in gap 3: between c and d
    expect(dropLayer(0, 3)).toBe(true);
    expect(sceneIds()).toEqual(['s0', 's1', 'b', 'c', 'a', 's2', 'd']);
  });

  it('dragging to the very top and the very bottom of the layers', () => {
    expect(dropLayer(2, 0)).toBe(true); // c to the top
    expect(visibleIds()).toEqual(['c', 'a', 'b', 'd']);
    expect(dropLayer(0, 4)).toBe(true); // and back to the bottom
    expect(visibleIds()).toEqual(['a', 'b', 'd', 'c']);
  });

  it('the visible order after any drop is the order the indicator promised', () => {
    // every (from, gap) pair: the list reads exactly like a plain splice of the displayed layers
    for (let from = 0; from < 4; from++) {
      for (let gap = 0; gap <= 4; gap++) {
        useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: nodes() } }));
        const expected = ['a', 'b', 'c', 'd'];
        const to = moveTarget(from, gap);
        if (to !== null) {
          const [moved] = expected.splice(from, 1);
          expected.splice(to, 0, moved);
        }
        dropLayer(from, gap);
        expect(visibleIds(), `from ${from} gap ${gap}`).toEqual(expected);
        // selection nodes are never lost or duplicated
        expect([...sceneIds()].sort()).toEqual(ids(nodes()).sort());
      }
    }
  });

  it('own-slot drops write nothing', () => {
    const before = useSceneStore.getState().scene;
    expect(dropLayer(1, 1)).toBe(false);
    expect(dropLayer(1, 2)).toBe(false);
    expect(useSceneStore.getState().scene).toBe(before);
  });

  it('the Layer menu moves step over selection nodes', () => {
    const all = nodes();
    expect(layerMoveRealIndex(all, 'b', 'forward')).toBe(1); // above a, past s1
    expect(layerMoveRealIndex(all, 'a', 'backward')).toBe(3); // below b
    expect(layerMoveRealIndex(all, 'd', 'front')).toBe(1);
    expect(layerMoveRealIndex(all, 'a', 'back')).toBe(6);
  });

  it('the Layer menu no-ops at the layer edges, and for a selection node or an unknown id', () => {
    const all = nodes();
    expect(layerMoveRealIndex(all, 'a', 'forward')).toBeNull();
    expect(layerMoveRealIndex(all, 'd', 'backward')).toBeNull();
    expect(layerMoveRealIndex(all, 's1', 'forward')).toBeNull();
    expect(layerMoveRealIndex(all, 'nope', 'front')).toBeNull();
  });

  it('applying the menu targets reorders the visible layers as asked', () => {
    const apply = (id: string, move: 'forward' | 'backward' | 'front' | 'back') => {
      const to = layerMoveRealIndex(useSceneStore.getState().scene.nodes, id, move);
      if (to !== null) useSceneStore.getState().reorderNode(id, to);
    };
    apply('c', 'forward');
    expect(visibleIds()).toEqual(['a', 'c', 'b', 'd']);
    apply('a', 'backward');
    expect(visibleIds()).toEqual(['c', 'a', 'b', 'd']);
    apply('d', 'front');
    expect(visibleIds()).toEqual(['d', 'c', 'a', 'b']);
    apply('d', 'back');
    expect(visibleIds()).toEqual(['c', 'a', 'b', 'd']);
  });
});

function visibleIds() {
  return ids(layerNodes(useSceneStore.getState().scene.nodes));
}
