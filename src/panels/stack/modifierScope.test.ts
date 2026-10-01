import { PropertyPanel, registerBuiltinRenderers, registerScope } from '@preset.nz/facets';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from '@/scene/store';
import type { Modifier, PixelNode } from '@/scene/types';
import type { OpDescriptor, OpParamSpec } from '@/sidecar/opsCache';
import { registerModifierFieldRenderers } from './modifierFieldRenderers';
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

// --- disabledWhen pass-through (Epic 18 story 5) ---------------------------

describe('paramToField disabledWhen pass-through', () => {
  it('copies disabledWhen through for a spec that carries it', () => {
    const spec: OpParamSpec = {
      name: 'seed',
      type: 'int',
      default: 0,
      scale: 'none',
      disabledWhen: { path: 'pattern', notIn: ['dashes', 'stipple'] },
    };
    const field = opParamsToSchema({ name: 'hatch_test', backend: 'python', params: [spec] })
      .groups[0].rows[0] as ModifierNumberFieldDef;

    expect(field.disabledWhen).toEqual({ path: 'pattern', notIn: ['dashes', 'stipple'] });
  });

  it('leaves disabledWhen absent for a spec that has none', () => {
    const spec: OpParamSpec = { name: 'amount', type: 'float', default: 0.5, scale: 'none' };
    const field = opParamsToSchema({ name: 'hatch_test', backend: 'python', params: [spec] })
      .groups[0].rows[0] as ModifierNumberFieldDef;

    expect('disabledWhen' in field).toBe(false);
  });
});

// --- PropertyPanel rendering: disabledWhen end to end (Epic 18 story 5) ---
//
// `renderToStaticMarkup` (react-dom/server) is a real React render pass —
// hooks run, including `PropertyPanel`'s own `useMemo` — in vitest's default
// `node` test environment, so no jsdom/testing-library dependency is
// needed. This exercises `@preset.nz/facets`' own `FieldSlot` disabled
// evaluation, not a reimplementation of its equals/notEquals/in/notIn
// precedence.

registerBuiltinRenderers();
registerModifierFieldRenderers();

// A trimmed stand-in for the real `hatch` descriptor, carrying only the
// params this story's acceptance criterion names plus the two paths they
// reference (`pattern`, `paper_is_alpha`) — the sidecar's own `hatch`
// annotations are covered end to end by `sidecar/tests/test_hatch.py`.
const HATCH_LIKE_OP: OpDescriptor = {
  name: 'hatch_disabled_when_test',
  backend: 'python',
  params: [
    {
      name: 'pattern',
      type: 'enum',
      default: 'lines',
      scale: 'none',
      choices: ['lines', 'dashes', 'crosses', 'stipple'],
    },
    {
      name: 'pen',
      type: 'float',
      default: 1,
      scale: 'none',
      disabledWhen: { path: 'pattern', equals: 'stipple' },
    },
    {
      name: 'cross_size',
      type: 'float',
      default: 1,
      scale: 'none',
      disabledWhen: { path: 'pattern', notEquals: 'crosses' },
    },
    {
      name: 'cross_aspect',
      type: 'float',
      default: 1,
      scale: 'none',
      disabledWhen: { path: 'pattern', notEquals: 'crosses' },
    },
    { name: 'paper_is_alpha', type: 'bool', default: false, scale: 'none' },
    {
      name: 'paper',
      type: 'color',
      default: '#ffffff',
      scale: 'none',
      disabledWhen: { path: 'paper_is_alpha', equals: true },
    },
    {
      name: 'seed',
      type: 'int',
      default: 0,
      scale: 'none',
      disabledWhen: { path: 'pattern', notIn: ['dashes', 'stipple'] },
    },
  ],
};

const HATCH_LIKE_LABELS = HATCH_LIKE_OP.params.map((p) => p.name);

/** Every field renders its label as a plain text node (`>label<`), so a
 * label's markup slice runs from its own label marker to the next field's —
 * order matches `descriptor.params` (unaffected by this story). Isolates a
 * field's `disabled=""` from its neighbours' without depending on facets'
 * internal DOM structure. */
function fieldIsDisabled(markup: string, label: string): boolean {
  const start = markup.indexOf(`>${label}<`);
  if (start === -1) throw new Error(`field label not found in markup: ${label}`);
  const laterStarts = HATCH_LIKE_LABELS.filter((l) => l !== label)
    .map((l) => markup.indexOf(`>${l}<`))
    .filter((i) => i > start);
  const end = laterStarts.length > 0 ? Math.min(...laterStarts) : markup.length;
  return markup.slice(start, end).includes('disabled=""');
}

function renderHatchPanel(pattern: string): string {
  const scopeKey = modifierScopeKey(HATCH_LIKE_OP.name);
  registerScope(scopeKey, buildModifierScope(HATCH_LIKE_OP));

  const node = pixelNode('node-1', {
    modifiers: [modifier('mod-1', { type: HATCH_LIKE_OP.name, params: { pattern } })],
  });
  useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [node] } }));

  return renderToStaticMarkup(
    createElement(PropertyPanel, {
      scopeKey,
      selection: { nodeId: 'node-1', modId: 'mod-1' },
      ctx: {},
    }),
  );
}

describe('PropertyPanel rendering a hatch-like descriptor', () => {
  it('pattern: lines disables seed, cross_size and cross_aspect, and leaves pen enabled', () => {
    const markup = renderHatchPanel('lines');

    expect(fieldIsDisabled(markup, 'seed')).toBe(true);
    expect(fieldIsDisabled(markup, 'cross_size')).toBe(true);
    expect(fieldIsDisabled(markup, 'cross_aspect')).toBe(true);
    expect(fieldIsDisabled(markup, 'pen')).toBe(false);
  });

  it('pattern: stipple disables pen, and leaves seed enabled', () => {
    const markup = renderHatchPanel('stipple');

    expect(fieldIsDisabled(markup, 'pen')).toBe(true);
    expect(fieldIsDisabled(markup, 'seed')).toBe(false);
  });
});

// --- label + description (Epic 04, param-labels story) ---------------------

describe('paramToField label and description', () => {
  function fieldFor(spec: OpParamSpec) {
    return opParamsToSchema({ name: 'labels_test', backend: 'python', params: [spec] }).groups[0]
      .rows[0] as ModifierNumberFieldDef & { description?: string };
  }

  it('uses spec.label when present and falls back to spec.name when not', () => {
    const labelled = fieldFor({
      name: 'cell_size',
      type: 'int',
      default: 8,
      scale: 'spatial',
      label: 'Cell size',
    });
    expect(labelled.label).toBe('Cell size');

    const bare = fieldFor({ name: 'cell_size', type: 'int', default: 8, scale: 'spatial' });
    expect(bare.label).toBe('cell_size');
    expect('description' in bare).toBe(false);
  });

  it.each([
    ['float', { name: 'a', type: 'float', default: 0, scale: 'none' }],
    ['int', { name: 'a', type: 'int', default: 0, scale: 'none', widget: 'slider' }],
    ['enum', { name: 'a', type: 'enum', default: 'x', scale: 'none', choices: ['x', 'y'] }],
    ['color', { name: 'a', type: 'color', default: '#000000', scale: 'none' }],
  ] as [string, OpParamSpec][])('carries description on a %s field', (_kind, spec) => {
    const field = fieldFor({ ...spec, description: 'Does a thing.' });
    expect(field.description).toBe('Does a thing.');
  });

  it('gives bool params the label but no description (builtin checkbox renderer)', () => {
    const field = fieldFor({
      name: 'paper_is_alpha',
      type: 'bool',
      default: false,
      scale: 'none',
      label: 'Paper is transparent',
      description: 'Makes the paper transparent.',
    });
    expect(field.label).toBe('Paper is transparent');
    expect('description' in field).toBe(false);
  });

  it('renders the label in the panel, and the raw name for an unannotated op', () => {
    registerBuiltinRenderers();
    registerModifierFieldRenderers();
    const descriptor: OpDescriptor = {
      name: 'labels_panel_test',
      backend: 'python',
      params: [
        {
          name: 'cell_size',
          type: 'int',
          default: 8,
          min: 1,
          max: 64,
          step: 1,
          scale: 'spatial',
          widget: 'slider',
          label: 'Cell size',
          description: 'Size of each mosaic cell in document pixels. Larger is blockier.',
        },
        { name: 'plain_param', type: 'float', default: 0.5, min: 0, max: 1, scale: 'none' },
      ],
    };
    const scopeKey = modifierScopeKey(descriptor.name);
    registerScope(scopeKey, buildModifierScope(descriptor));
    const node = pixelNode('node-1', {
      modifiers: [modifier('mod-1', { type: descriptor.name })],
    });
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [node] } }));

    const markup = renderToStaticMarkup(
      createElement(PropertyPanel, {
        scopeKey,
        selection: { nodeId: 'node-1', modId: 'mod-1' },
        ctx: {},
      }),
    );

    expect(markup).toContain('>Cell size<');
    expect(markup).not.toContain('>cell_size<');
    expect(markup).toContain('>plain_param<');
  });
});
