import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from '@/scene/store';
import type { Modifier, PixelNode } from '@/scene/types';
import {
  insertionIndexFor,
  insertionLineY,
  layerMoveTarget,
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
