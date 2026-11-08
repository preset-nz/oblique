import {
  type FieldDef,
  PropertyPanel,
  registerBuiltinRenderers,
  registerScope,
} from '@preset.nz/facets';
import { levelsCurve, levelsLine } from '@preset.nz/ux-kit/graphics';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneStore } from '@/scene/store';
import type { Modifier, PixelNode } from '@/scene/types';
import type { OpDescriptor, OpParamSpec } from '@/sidecar/opsCache';
import {
  levelsToDraw,
  registerModifierFieldRenderers,
  roundGamma,
  snapToStep,
  valueFromCurve,
} from './modifierFieldRenderers';
import {
  buildModifierScope,
  type CurveValue,
  type ModifierCurveFieldDef,
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

  it('shows a choice by its label when the sidecar sent one, and by its value otherwise', () => {
    const descriptor: OpDescriptor = {
      name: 'labelled_choice_op',
      backend: 'python',
      params: [
        {
          name: 'stock',
          type: 'enum',
          default: 'polaroid_600',
          scale: 'none',
          choices: ['polaroid_600', 'expired'],
          choice_labels: { polaroid_600: 'Instant' },
        },
      ],
    };
    const field = opParamsToSchema(descriptor).groups[0].rows[0];
    expect(field).toMatchObject({
      kind: 'select',
      options: [
        { value: 'polaroid_600', label: 'Instant' },
        { value: 'expired', label: 'expired' },
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

// --- Levels' curve (levels-curve.md, phase 1) ---

// Levels as the sidecar declares it (sidecar/ops/levels.py): gamma asks for the curve widget.
const LEVELS_LIKE_OP: OpDescriptor = {
  name: 'levels_curve_test',
  backend: 'python',
  histogram: true,
  params: [
    {
      name: 'black',
      type: 'float',
      default: 0,
      min: 0,
      max: 255,
      step: 1,
      scale: 'none',
      label: 'Black point',
    },
    {
      name: 'white',
      type: 'float',
      default: 255,
      min: 0,
      max: 255,
      step: 1,
      scale: 'none',
      label: 'White point',
    },
    {
      name: 'gamma',
      type: 'float',
      default: 1,
      min: 0.1,
      max: 5,
      step: 0.05,
      scale: 'none',
      label: 'Gamma',
      description: 'Midtone brightness.',
      widget: 'curve',
      curve: { black: 'black', white: 'white' },
    },
  ],
};

describe('widget: curve', () => {
  const rows = opParamsToSchema(LEVELS_LIKE_OP).groups[0].rows as FieldDef[];
  const curveField = rows[2] as unknown as ModifierCurveFieldDef;

  it("maps the param to a curve field with the param's own range and the ends' ranges, and leaves its neighbours as numbers", () => {
    expect(rows.map((r) => r.kind)).toEqual(['number', 'number', 'curve']);
    expect(curveField).toMatchObject({
      id: 'gamma',
      path: 'gamma',
      label: 'Gamma',
      description: 'Midtone brightness.',
      min: 0.1,
      max: 5,
      step: 0.05,
      black: { path: 'black', min: 0, max: 255, step: 1 },
      white: { path: 'white', min: 0, max: 255, step: 1 },
    });
  });

  it('takes the ends from the ranges of the params the backend names, not from 255', () => {
    const op: OpDescriptor = {
      name: 'ends_test',
      backend: 'python',
      params: [
        { name: 'lo', type: 'float', default: 0, min: 0, max: 100, step: 5, scale: 'none' },
        { name: 'hi', type: 'float', default: 100, min: 0, max: 100, scale: 'none' },
        {
          name: 'g',
          type: 'float',
          default: 1,
          min: 0.1,
          max: 5,
          scale: 'none',
          widget: 'curve',
          curve: { black: 'lo', white: 'hi' },
        },
      ],
    };
    const field = opParamsToSchema(op).groups[0].rows[2] as unknown as ModifierCurveFieldDef;
    expect(field.black).toEqual({ path: 'lo', min: 0, max: 100, step: 5 });
    expect(levelsToDraw(field, { black: 25, white: 75, gamma: 2 })).toEqual({
      black: 0.25,
      white: 0.75,
      gamma: 2,
    });
  });

  it('keeps a curve param without named ends, or an int one, a number field', () => {
    const field = (spec: OpParamSpec) =>
      opParamsToSchema({ name: 'x', backend: 'python', params: [spec] }).groups[0]
        .rows[0] as FieldDef;
    expect(
      field({ name: 'a', type: 'float', default: 1, scale: 'none', widget: 'curve' }).kind,
    ).toBe('number');
    expect(
      field({
        name: 'a',
        type: 'int',
        default: 1,
        scale: 'none',
        widget: 'curve',
        curve: { black: 'a', white: 'a' },
      }).kind,
    ).toBe('number');
  });

  function nodeWith(params: Record<string, number>) {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          pixelNode('node-1', {
            modifiers: [modifier('mod-1', { type: LEVELS_LIKE_OP.name, params })],
          }),
        ],
      },
    }));
  }
  const selection = { nodeId: 'node-1', modId: 'mod-1' };
  const storedParams = () =>
    (useSceneStore.getState().scene.nodes[0] as PixelNode).modifiers[0].params;

  it('reads the curve field as black, white and gamma from the three params, defaults for any not set', () => {
    nodeWith({ black: 20, gamma: 2 });
    const values = buildModifierScope(LEVELS_LIKE_OP).read(selection, null);
    expect(values.gamma).toEqual({ black: 20, white: 255, gamma: 2 });
    // the neighbours' own fields are untouched by it
    expect(values.black).toBe(20);
    expect(values.white).toBe(255);
  });

  it('a write of the curve value sets only the params that changed', () => {
    nodeWith({ black: 20, white: 230, gamma: 1.2345 });
    const scope = buildModifierScope(LEVELS_LIKE_OP);
    scope.write?.('gamma', { black: 20, white: 200, gamma: 1.2345 }, selection, null);
    expect(storedParams()).toEqual({ black: 20, white: 200, gamma: 1.2345 });
    scope.write?.('gamma', { black: 40, white: 200, gamma: 3 }, selection, null);
    expect(storedParams()).toEqual({ black: 40, white: 200, gamma: 3 });
  });

  it('a plain number written to gamma is still just gamma', () => {
    nodeWith({ black: 20, white: 230 });
    buildModifierScope(LEVELS_LIKE_OP).write?.('gamma', 2.5, selection, null);
    expect(storedParams()).toEqual({ black: 20, white: 230, gamma: 2.5 });
  });

  function renderLevels(params: Record<string, number>): string {
    const scopeKey = modifierScopeKey(LEVELS_LIKE_OP.name);
    registerScope(scopeKey, buildModifierScope(LEVELS_LIKE_OP));
    nodeWith(params);
    return renderToStaticMarkup(
      createElement(PropertyPanel, { scopeKey, selection, ctx: 'node-1/mod-1' }),
    );
  }

  // The editor reads its colours from CSS custom properties on mount; a render pass has no DOM.
  beforeAll(() => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  });
  afterAll(() => vi.unstubAllGlobals());

  it('shows the curve in addition to the Black point, White point and Gamma number fields', () => {
    const markup = renderLevels({ black: 20, white: 230, gamma: 2 });
    expect(markup).toContain('aria-label="Levels curve"');
    expect(markup).toContain('>Black point<');
    expect(markup).toContain('>White point<');
    // the Gamma number field is still there, with its value
    expect(markup).toMatch(/>Gamma<[\s\S]*value="2"/);
  });
});

describe('levels curve helpers', () => {
  const field = opParamsToSchema(LEVELS_LIKE_OP).groups[0]
    .rows[2] as unknown as ModifierCurveFieldDef;
  const value = (black: number, white: number, gamma: number): CurveValue => ({
    black,
    white,
    gamma,
  });

  it('the field moves the curve: value to curve to value is the identity', () => {
    for (const v of [
      value(0, 255, 1),
      value(20, 230, 1.6),
      value(100, 101, 0.1),
      value(0, 255, 5),
    ]) {
      expect(valueFromCurve(field, value(0, 255, 1), levelsCurve(levelsToDraw(field, v)))).toEqual(
        // the keys that differ from the start are written, the rest stay the start's
        {
          black: v.black,
          white: v.white,
          gamma: v.gamma,
        },
      );
    }
  });

  it('dragging an end writes that end, rounded to a whole level, and nothing else', () => {
    const current = value(20, 230, 1.23456);
    const dragged = levelsCurve({ black: 40.4 / 255, white: 230 / 255, gamma: 1.23456 });
    expect(valueFromCurve(field, current, dragged)).toEqual({ ...current, black: 40 });
    const white = levelsCurve({ black: 20 / 255, white: 199.6 / 255, gamma: 1.23456 });
    expect(valueFromCurve(field, current, white)).toEqual({ ...current, white: 200 });
  });

  it('dragging the point writes gamma to three places, and not the ends', () => {
    const current = value(20, 230, 1);
    const next = levelsCurve({ black: 20 / 255, white: 230 / 255, gamma: 1.23456 });
    expect(valueFromCurve(field, current, next)).toEqual({ ...current, gamma: 1.235 });
  });

  it('a curve of another shape writes nothing', () => {
    expect(
      valueFromCurve(field, value(0, 255, 1), {
        points: [
          { x: 0, y: 0, basis: 'linear' },
          { x: 1, y: 1, basis: 'linear' },
        ],
      }),
    ).toBeNull();
  });

  it('a value that is not usable draws the identity: ends at min and max, gamma 1', () => {
    for (const bad of [undefined, null, 'x', {}, { black: 'a', white: null, gamma: -2 }]) {
      expect(levelsToDraw(field, bad)).toEqual({ black: 0, white: 1, gamma: 1 });
    }
  });

  it('snapToStep and roundGamma', () => {
    expect(snapToStep(40.4, 0, 255, 1)).toBe(40);
    expect(snapToStep(-3, 0, 255, 1)).toBe(0);
    expect(snapToStep(300, 0, 255, 1)).toBe(255);
    expect(snapToStep(23, 0, 100, 5)).toBe(25);
    expect(roundGamma(1.00049)).toBe(1);
    expect(roundGamma(1.0005)).toBe(1.001);
  });

  it("the line is the op's remap ((x-b)/(w-b))^(1/g) with flat ends, at every pixel column", () => {
    const width = 400;
    for (const [b, w, g] of [
      [0, 1, 1],
      [0.1, 0.9, 1],
      [0.2, 0.7, 0.1],
      [0.05, 0.4, 5],
      [0.3, 1, 2.2],
      [0, 0.5, 0.45],
    ]) {
      const curve = levelsCurve({ black: b, white: w, gamma: g });
      for (let col = 0; col <= width; col++) {
        const x = col / width;
        const expected = x <= b ? 0 : x >= w ? 1 : ((x - b) / (w - b)) ** (1 / g);
        expect(levelsLine(x, curve)).toBeCloseTo(expected, 12);
      }
    }
  });
});
