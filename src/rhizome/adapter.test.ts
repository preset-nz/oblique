import { describe, expect, it } from 'vitest';
import type { Modifier, PixelNode, Scene, TextNode, VectorNode } from '@/scene/types';
import {
  firstDifference,
  layerPath,
  Mirror,
  normal,
  PARAM_PREFIX,
  reorderMoves,
  rowsFromScene,
  sceneFromRows,
  transform2d,
} from './adapter';
import type { Row, Update } from './transport';

const base = {
  state: 'active' as const,
  output: 'image' as const,
  cameraId: null,
  visible: true,
  blendMode: 'normal' as const,
  opacity: 1,
  dirty: { draft: false, working: false },
};

const blur: Modifier = {
  id: 'm1',
  type: 'blur',
  enabled: true,
  // `enabled` is an op param here on purpose: it must never meet the modifier's own switch
  params: { radius: 12.5, mode: 'soft', enabled: 7, tint: '#ff0000', on: false },
  maskId: 'mask1',
};

const pixel: PixelNode = {
  ...base,
  id: 'p1',
  type: 'pixel',
  label: 'Photo',
  modifiers: [blur, { id: 'm2', type: 'sharpen', enabled: false, params: {} }],
  sourcePath: 'photos/a.png',
  sourceSize: [640, 480],
  transform2d: { x: 10, y: -4.5, scaleX: 2, scaleY: 0.5, rotation: 0.25 },
};

const vector: VectorNode = {
  ...base,
  id: 'v1',
  type: 'vector',
  label: 'Shape',
  modifiers: [],
  paths: [
    {
      closed: true,
      anchors: [
        { point: { x: 0, y: 0 } },
        { point: { x: 10, y: 0 }, handleOut: { x: 12, y: 2 } },
        { point: { x: 5, y: 9 }, handleIn: { x: 4, y: 8 }, handleOut: { x: 6, y: 8 } },
      ],
    },
  ],
  fillRule: 'evenodd',
  visible: false,
  opacity: 0.4,
  blendMode: 'multiply',
};

const text: TextNode = {
  ...base,
  id: 't1',
  type: 'text',
  label: 'Hello',
  modifiers: [],
  content: 'Hello\nthere',
  font: {
    family: 'Inter',
    style: 'Regular',
    postscriptName: 'Inter-Regular',
    weight: 400,
    italic: false,
    category: 'sans',
  },
  fontSize: 72,
  tracking: 0,
  kerning: 100,
  lineHeight: 1.2,
  align: 'left',
  fill: '#ffffff',
  stroke: { color: '#000000', width: 2 },
  position: { x: 10, y: 20 },
  state: 'locked',
};

const scene: Scene = {
  id: 'scene-1',
  nodes: [pixel, vector, text],
  cameras: [],
  defaultCameraId: null,
  resolution: 'working',
  documentSize: [1920, 1080],
  maskRefs: {
    mask1: {
      id: 'mask1',
      nodeId: 'v1',
      featherPx: 3,
      expand: -1,
      invert: true,
      space: 'node',
      attachTransform: { x: 1, y: 2, scaleX: 1, scaleY: 1, rotation: 0 },
    },
  },
  note: 'a note',
  background: { type: 'color', color: '#112233' },
};

describe('the scene as a rhizome tree', () => {
  it('survives scene -> tree -> scene, in stack order', () => {
    const back = sceneFromRows(rowsFromScene(scene));
    expect(back).not.toBeNull();
    expect(firstDifference(normal(scene), normal(back as Scene))).toBeNull();
    expect(back?.nodes.map((n) => n.id)).toEqual(['p1', 'v1', 't1']);
  });

  it('keeps an empty document empty', () => {
    const empty: Scene = {
      id: 'e',
      nodes: [],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [0, 0],
    };
    const back = sceneFromRows(rowsFromScene(empty)) as Scene;
    expect(firstDifference(normal(empty), normal(back))).toBeNull();
    expect(back.note).toBeUndefined();
    expect(back.background).toBeUndefined();
  });

  it('puts every op param under params.<name>, apart from the modifier enabled switch', () => {
    const rows = rowsFromScene(scene);
    const m1 = [...rows.values()].find((r) => r.path === `${layerPath('p1')}/m1`) as Row;
    expect(m1.type).toBe('op.blur');
    expect(m1.values?.enabled).toBe(true);
    expect(m1.values?.[`${PARAM_PREFIX}enabled`]).toBe(7);
    expect(m1.set).toContain('params.radius');
    expect(m1.set).not.toContain('radius');
    const back = sceneFromRows(rows) as Scene;
    const mod = back.nodes[0].modifiers[0];
    expect(mod.enabled).toBe(true);
    expect(mod.params).toEqual(blur.params);
    expect(back.nodes[0].modifiers[1]).toEqual({
      id: 'm2',
      type: 'sharpen',
      enabled: false,
      params: {},
    });
  });

  it('reads a params.<name> row even when the op param is called enabled', () => {
    const row: Row = {
      id: 'x',
      path: '/layers/p/m',
      name: 'm',
      type: 'op.blur',
      role: 'node',
      parent: 'l',
      values: { enabled: false, 'params.enabled': 3 },
      set: ['enabled', 'params.enabled'],
    };
    const layer: Row = {
      id: 'l',
      path: '/layers/p',
      name: 'p',
      type: 'vector',
      role: 'node',
      parent: 'layers',
      orders: { modifiers: ['x'] },
      values: { paths: [], fillRule: 'nonzero' },
    };
    const rows = rowsFromScene({ ...scene, nodes: [], maskRefs: {} });
    rows.set('x', row);
    rows.set('l', layer);
    const layers = [...rows.values()].find((r) => r.path === '/layers') as Row;
    layers.orders = { stack: ['l'] };
    const mod = (sceneFromRows(rows) as Scene).nodes[0].modifiers[0];
    expect(mod.enabled).toBe(false);
    expect(mod.params).toEqual({ enabled: 3 });
  });

  it('has no transform2d on a layer that was never moved', () => {
    const rows = rowsFromScene(scene);
    const v1 = [...rows.values()].find((r) => r.path === layerPath('v1')) as Row;
    expect(transform2d(v1)).toBeUndefined();
    expect((sceneFromRows(rows) as Scene).nodes[1].transform2d).toBeUndefined();
  });

  it('is JSON-serialisable, as the scene must stay', () => {
    const back = sceneFromRows(rowsFromScene(scene)) as Scene;
    expect(JSON.parse(JSON.stringify(back))).toEqual(back);
  });

  it('compares scenes without cook state or the scene id', () => {
    const other: Scene = {
      ...scene,
      id: 'another',
      nodes: scene.nodes.map((n) => ({ ...n, dirty: { draft: true, working: true } })),
    };
    expect(firstDifference(normal(scene), normal(other))).toBeNull();
    const moved: Scene = { ...scene, documentSize: [1, 1] };
    expect(firstDifference(normal(scene), normal(moved))).toContain('documentSize');
  });
});

describe('the mirror', () => {
  const view = (s: Scene) => ({
    seq: 4,
    generation: 1,
    schema: null,
    rows: [...rowsFromScene(s).values()],
  });
  const update = (seq: number, rows: Row[] = [], generation = 1): Update => ({
    seq,
    label: 'x',
    changes: [],
    rows,
    removed: [],
    generation,
  });

  it('loads a view and answers by path', () => {
    const m = new Mirror();
    m.load(view(scene));
    expect(m.seq).toBe(4);
    expect(m.byPath(layerPath('p1'))?.name).toBe('p1');
    expect(firstDifference(normal(scene), normal(m.scene() as Scene))).toBeNull();
  });

  it('applies the next update, ignores a stale one, and reports a gap', () => {
    const m = new Mirror();
    m.load(view(scene));
    const moved = { ...(m.byPath(layerPath('p1')) as Row) };
    moved.values = { ...moved.values, opacity: 0.2 };
    expect(m.apply(update(5, [moved]))).toBe('applied');
    expect(m.scene()?.nodes[0].opacity).toBe(0.2);
    expect(m.apply(update(5))).toBe('stale');
    expect(m.apply(update(9))).toBe('gap');
    expect(m.apply(update(6, [], 2))).toBe('stale'); // another generation
    expect(m.seq).toBe(5);
  });

  it('drops removed rows', () => {
    const m = new Mirror();
    m.load(view(scene));
    const row = m.byPath(layerPath('v1')) as Row;
    const layers = {
      ...(m.byPath('/layers') as Row),
      orders: { stack: ['row:layer:p1', 'row:layer:t1'] },
    };
    expect(m.apply({ ...update(5, [layers]), removed: [row.id] })).toBe('applied');
    expect(m.byPath(layerPath('v1'))).toBeUndefined();
    expect(m.scene()?.nodes.map((n) => n.id)).toEqual(['p1', 't1']);
  });
});

describe('reorderMoves', () => {
  /** Applies the calls the way the store's reorderNode does. */
  const applied = (start: string[], moves: { id: string; to: number }[]) => {
    const v = [...start];
    for (const m of moves) {
      v.splice(v.indexOf(m.id), 1);
      v.splice(m.to, 0, m.id);
    }
    return v;
  };

  it('is one call for one move, up or down, to either end or the middle', () => {
    const start = ['a', 'b', 'c', 'd', 'e'];
    for (const id of start) {
      for (let to = 0; to < start.length; to++) {
        const target = applied(start, [{ id, to }]);
        const moves = reorderMoves(start, target);
        expect(applied(start, moves), `${id} to ${to}`).toEqual(target);
        expect(moves.length, `${id} to ${to}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gets any other order right, too', () => {
    const start = ['a', 'b', 'c', 'd', 'e'];
    const target = ['c', 'a', 'e', 'b', 'd'];
    expect(applied(start, reorderMoves(start, target))).toEqual(target);
  });

  it('does nothing for the same order, or for layers that were added or removed', () => {
    expect(reorderMoves(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(reorderMoves(['a', 'b'], ['a'])).toEqual([]);
    expect(reorderMoves(['a'], ['a', 'b'])).toEqual([]);
    expect(reorderMoves(['a', 'b'], ['a', 'c'])).toEqual([]);
  });
});
