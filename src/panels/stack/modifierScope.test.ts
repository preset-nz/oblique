import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from '@/scene/store';
import type { Modifier, PixelNode } from '@/scene/types';
import type { OpDescriptor } from '@/sidecar/opsCache';
import {
  buildModifierScope,
  type ModifierNumberFieldDef,
  type ModifierSliderFieldDef,
  modifierScopeKey,
  opParamsToSchema,
} from './modifierScope';

function pixelNode(id: string, overrides: Partial<PixelNode> = {}): PixelNode {
  return {
    id,
    label: 'Layer',
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    sourcePath: '/tmp/a.png',
    sourceSize: [100, 100],
    ...overrides,
  };
}

function modifier(id: string, overrides: Partial<Modifier> = {}): Modifier {
  return { id, type: 'gaussian_blur', enabled: true, params: {}, ...overrides };
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

// A throwaway op descriptor with one param of every type the sidecar can
// report, plus a `widget: 'slider'` hint — the epic's headline "zero
// TypeScript changes" contract, exercised without touching the sidecar.
const NOVEL_OP: OpDescriptor = {
  name: 'grim_dark_test_op',
  backend: 'python',
  params: [
    { name: 'amount', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, scale: 'none' },
    {
      name: 'radius',
      type: 'float',
      default: 4,
      min: 0,
      max: 100,
      step: 0.5,
      scale: 'spatial',
      widget: 'slider',
    },
    { name: 'seed', type: 'int', default: 0, min: 0, max: 9999, step: 1, scale: 'none' },
    { name: 'passes', type: 'int', default: 1, min: 1, max: 8, scale: 'none', widget: 'slider' },
    { name: 'invert', type: 'bool', default: false, scale: 'none' },
    {
      name: 'mode',
      type: 'enum',
      default: 'grim',
      scale: 'none',
      choices: ['grim', 'dark', 'both'],
    },
    { name: 'ink', type: 'color', default: '#00ffff', scale: 'none' },
  ],
};

describe('opParamsToSchema', () => {
  const schema = opParamsToSchema(NOVEL_OP);

  it('produces one group named for the op', () => {
    expect(schema.groups).toHaveLength(1);
    expect(schema.groups[0].id).toBe('grim_dark_test_op');
  });

  it('produces exactly one FieldDef row per param, in order, zero TS changes needed', () => {
    const rows = schema.groups[0].rows;
    expect(rows).toHaveLength(NOVEL_OP.params.length);
    expect(rows.map((r) => (Array.isArray(r) ? undefined : r.id))).toEqual([
      'amount',
      'radius',
      'seed',
      'passes',
      'invert',
      'mode',
      'ink',
    ]);
  });

  it('maps a plain float param to a number field carrying its bounds/step', () => {
    const field = schema.groups[0].rows[0] as ModifierNumberFieldDef;
    expect(field.kind).toBe('number');
    expect(field.min).toBe(0);
    expect(field.max).toBe(1);
    expect(field.step).toBe(0.01);
    expect(field.integerStep).toBe(false);
  });

  it('maps a `widget: slider` float param to the slider kind', () => {
    const field = schema.groups[0].rows[1] as ModifierSliderFieldDef;
    expect(field.kind).toBe('slider');
    expect(field.step).toBe(0.5);
    expect(field.integerStep).toBe(false);
  });

  it('maps an int param to a number field with integerStep set', () => {
    const field = schema.groups[0].rows[2] as ModifierNumberFieldDef;
    expect(field.kind).toBe('number');
    expect(field.integerStep).toBe(true);
    expect(field.step).toBe(1);
  });

  it('defaults int step to 1 when the spec omits it', () => {
    const field = schema.groups[0].rows[3] as ModifierSliderFieldDef;
    expect(field.kind).toBe('slider');
    expect(field.integerStep).toBe(true);
    expect(field.step).toBe(1);
  });

  it('maps a bool param to checkbox', () => {
    const field = schema.groups[0].rows[4];
    expect(field).toMatchObject({ kind: 'checkbox', id: 'invert' });
  });

  it('maps an enum param to select with its choices as options', () => {
    const field = schema.groups[0].rows[5];
    expect(field).toMatchObject({
      kind: 'select',
      id: 'mode',
      options: [
        { value: 'grim', label: 'grim' },
        { value: 'dark', label: 'dark' },
        { value: 'both', label: 'both' },
      ],
    });
  });

  it('maps a color param to the color kind, no per-op TypeScript needed', () => {
    const field = schema.groups[0].rows[6];
    expect(field).toMatchObject({ kind: 'color', id: 'ink' });
  });
});

describe('modifierScopeKey', () => {
  it('namespaces by op type, since each op has its own schema', () => {
    expect(modifierScopeKey('gaussian_blur')).toBe('modifier:gaussian_blur');
    expect(modifierScopeKey('grim_dark_test_op')).toBe('modifier:grim_dark_test_op');
  });
});

describe('buildModifierScope', () => {
  it('read falls back to spec defaults for params not yet set on the modifier', () => {
    const node = pixelNode('node-1', {
      modifiers: [modifier('mod-1', { params: { amount: 0.9 } })],
    });
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [node] } }));

    const scope = buildModifierScope(NOVEL_OP);
    const values = scope.read({ nodeId: 'node-1', modId: 'mod-1' }, {});

    expect(values.amount).toBe(0.9); // set explicitly
    expect(values.radius).toBe(4); // falls back to spec default
    expect(values.seed).toBe(0);
    expect(values.mode).toBe('grim');
  });

  it('write commits through setModifierParam and dirties the node (cook-pipeline dirty rule)', () => {
    const node = pixelNode('node-1', {
      modifiers: [modifier('mod-1', { params: { radius: 4 } })],
      dirty: { draft: false, working: false },
    });
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [node] } }));

    const scope = buildModifierScope(NOVEL_OP);
    scope.write?.('radius', 12, { nodeId: 'node-1', modId: 'mod-1' }, {});

    const updated = useSceneStore.getState().scene.nodes[0];
    expect(updated.modifiers[0].params.radius).toBe(12);
    expect(updated.dirty).toEqual({ draft: true, working: true });
  });

  it('read/write pass spatial-scaled params through untouched (document space, scaling happens below this layer)', () => {
    const node = pixelNode('node-1', {
      modifiers: [modifier('mod-1', { params: { radius: 20 } })],
    });
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [node] } }));

    const scope = buildModifierScope(NOVEL_OP);
    expect(scope.read({ nodeId: 'node-1', modId: 'mod-1' }, {}).radius).toBe(20);

    scope.write?.('radius', 30, { nodeId: 'node-1', modId: 'mod-1' }, {});
    expect(scope.read({ nodeId: 'node-1', modId: 'mod-1' }, {}).radius).toBe(30);
  });
});
