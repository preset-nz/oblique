import {
  type CheckboxFieldDef,
  type ColorFieldDef,
  type FieldDef,
  type NumberFieldDef,
  type PropertySchema,
  registerScope,
  type Scope,
  type SelectFieldDef,
  type SliderFieldDef,
} from '@preset.nz/facets';
import { useSceneStore } from '@/scene/store';
import type { OpDescriptor, OpParamSpec } from '@/sidecar/opsCache';

/**
 * `number`/`slider` FieldDefs generated from an `int`-typed `OpParamSpec`
 * carry this marker. `InputNumber`'s Alt (×0.1) multiplier goes fractional
 * for whole-step params (`grain.seed`, `grain.size`); the renderer wiring in
 * `modifierFieldRenderers.tsx` reads this flag to floor the effective
 * increment at one whole step. `InputNumber`/`inputNumberMath` stay generic —
 * this is a call-site concern of the modifier scope's translation, per the
 * story's design note.
 */
export interface ModifierNumberFieldDef extends NumberFieldDef {
  integerStep?: boolean;
  /** Hover text for the label, from the op's `ParamSpec.description`. */
  description?: string;
}

export interface ModifierSliderFieldDef extends SliderFieldDef {
  integerStep?: boolean;
  description?: string;
}

export interface ModifierSelectFieldDef extends SelectFieldDef {
  description?: string;
}

export interface ModifierColorFieldDef extends ColorFieldDef {
  description?: string;
}

/** One end of a curve: the param that sets it, and the range that puts it on the curve's 0..1 axis. */
export interface CurveEnd {
  path: string;
  min: number;
  max: number;
  step: number;
}

/**
 * What a curve field holds: its own param (`gamma`) and the four params that set the ends, in the
 * params' own units (levels: 0 to 255). `outBlack` and `outWhite` are how high the ends sit. `read`
 * builds it from the five, and a write of it changes only the params that differ from what the
 * modifier has.
 */
export interface CurveValue {
  black: number;
  white: number;
  gamma: number;
  outBlack: number;
  outWhite: number;
}

export type CurveKey = keyof CurveValue;
export const CURVE_KEYS: readonly CurveKey[] = ['black', 'white', 'gamma', 'outBlack', 'outWhite'];

/** Which key of the sidecar's `curve` map names the param behind each end key (gamma is the field's own). */
const CURVE_ROLE: Record<Exclude<CurveKey, 'gamma'>, keyof NonNullable<OpParamSpec['curve']>> = {
  black: 'black',
  white: 'white',
  outBlack: 'out_black',
  outWhite: 'out_white',
};

/** The param each key of a curve value is stored in: the roles' params, and the field's own for gamma. */
function curveParamNames(
  spec: OpParamSpec & { curve: NonNullable<OpParamSpec['curve']> },
): Record<CurveKey, string> {
  return {
    black: spec.curve[CURVE_ROLE.black],
    white: spec.curve[CURVE_ROLE.white],
    outBlack: spec.curve[CURVE_ROLE.outBlack],
    outWhite: spec.curve[CURVE_ROLE.outWhite],
    gamma: spec.name,
  };
}

/**
 * A float param the op's backend asks to be drawn as a curve (`widget: 'curve'`, with `curve`
 * naming the end params; levels). A custom field kind: `modifierFieldRenderers.tsx` registers the
 * renderer, which draws the curve and keeps the param's own number field with it. `min`/`max`/
 * `step` are the param's (gamma's) own; the four ends are the end params'.
 */
export type ModifierCurveFieldDef = {
  kind: 'curve';
  id: string;
  path: string;
  label?: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  black: CurveEnd;
  white: CurveEnd;
  outBlack: CurveEnd;
  outWhite: CurveEnd;
  disabledWhen?: FieldDef['disabledWhen'];
};

/** The selected stack row: one modifier instance on one scene node. */
export interface ModifierSelection {
  nodeId: string;
  modId: string;
}

function curveEnd(params: OpParamSpec[], name: string): CurveEnd | undefined {
  const end = params.find((p) => p.name === name);
  return end && end.min !== undefined && end.max !== undefined
    ? { path: name, min: end.min, max: end.max, step: end.step ?? 1 }
    : undefined;
}

function paramToField(spec: OpParamSpec, params: OpParamSpec[]): FieldDef {
  const base = {
    id: spec.name,
    path: spec.name,
    label: spec.label ?? spec.name,
    // Presentation-only greying (Epic 18 story 5) — no per-op special-casing,
    // this is a straight pass-through of whatever the op's home backend sent.
    ...(spec.disabledWhen ? { disabledWhen: spec.disabledWhen } : {}),
  };

  // Oblique's own number/slider/select/colour renderers show this as a label
  // tooltip. Builtin `checkbox` params keep the plain facets renderer (its
  // `BaseField` has no description; a shared package), so bools get the label only.
  const described = spec.description ? { description: spec.description } : {};

  switch (spec.type) {
    case 'bool':
      return { ...base, kind: 'checkbox' } satisfies CheckboxFieldDef;

    case 'color':
      return { ...base, ...described, kind: 'color' } satisfies ModifierColorFieldDef;

    case 'enum':
      return {
        ...base,
        ...described,
        kind: 'select',
        options: (spec.choices ?? []).map((choice) => ({
          value: choice,
          label: spec.choice_labels?.[choice] ?? choice,
        })),
      } satisfies ModifierSelectFieldDef;

    case 'int':
    case 'float': {
      const integerStep = spec.type === 'int';
      const shared = {
        ...base,
        ...described,
        min: spec.min,
        max: spec.max,
        step: spec.step ?? (integerStep ? 1 : 0.1),
        integerStep,
      };
      const black = spec.curve && curveEnd(params, spec.curve.black);
      const white = spec.curve && curveEnd(params, spec.curve.white);
      const outBlack = spec.curve && curveEnd(params, spec.curve.out_black);
      const outWhite = spec.curve && curveEnd(params, spec.curve.out_white);
      // a curve needs its ends named by the backend; without them it stays a number field
      if (spec.widget === 'curve' && !integerStep && black && white && outBlack && outWhite) {
        return {
          ...base,
          ...described,
          kind: 'curve',
          min: spec.min,
          max: spec.max,
          step: shared.step,
          black,
          white,
          outBlack,
          outWhite,
        } satisfies ModifierCurveFieldDef;
      }
      return spec.widget === 'slider'
        ? ({ ...shared, kind: 'slider' } satisfies ModifierSliderFieldDef)
        : ({ ...shared, kind: 'number' } satisfies ModifierNumberFieldDef);
    }
  }
}

/**
 * Translates a sidecar `list_ops` descriptor into a `PropertySchema` — one
 * group (the modifier itself) with one `FieldDef` per param. Op param
 * metadata always lives in the op's home backend; this function contains no
 * per-op-name special-casing, so a brand-new op with novel params renders
 * fully editable the moment `list_ops` reports it.
 */
export function opParamsToSchema(descriptor: OpDescriptor): PropertySchema {
  return {
    version: 1,
    groups: [
      {
        // No title: the StackRow header already shows the op label right
        // above this panel.
        id: descriptor.name,
        rows: descriptor.params.map((spec) => paramToField(spec, descriptor.params)),
      },
    ],
  };
}

/** Registry key for a given op type's modifier scope — one scope per op, since each op's schema differs. */
export function modifierScopeKey(opType: string): string {
  return `modifier:${opType}`;
}

function isCurveValue(value: unknown): value is CurveValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return CURVE_KEYS.every((key) => typeof v[key] === 'number');
}

function readModifierParams(
  descriptor: OpDescriptor,
  selection: ModifierSelection,
): Record<string, unknown> {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === selection.nodeId);
  const modifier = node?.modifiers.find((m) => m.id === selection.modId);
  const values: Record<string, unknown> = {};
  for (const spec of descriptor.params) {
    // Resolution-dependent (`scale: 'spatial'`) params are stored and edited
    // in document space always; the cook request scales them below this
    // layer (unchanged from Epic 02) — no conversion needed here.
    values[spec.name] = modifier?.params[spec.name] ?? spec.default;
  }
  // A curve field holds its ends too (levels' gamma: black, white and gamma), read from the
  // params the backend names, so typing in a sibling field moves the curve.
  for (const spec of descriptor.params) {
    if (spec.widget !== 'curve' || !spec.curve) continue;
    const names = curveParamNames({ ...spec, curve: spec.curve });
    values[spec.name] = {
      black: values[names.black],
      white: values[names.white],
      gamma: values[spec.name],
      outBlack: values[names.outBlack],
      outWhite: values[names.outWhite],
    };
  }
  return values;
}

/**
 * Builds the `modifier` scope for one op type: `read` pulls the selected
 * modifier's params (falling back to the spec defaults for anything not yet
 * set); `write` commits through `setModifierParam`, which dirties the node
 * per the cook-pipeline dirty rule.
 */
export function buildModifierScope(
  descriptor: OpDescriptor,
): Scope<ModifierSelection, Record<string, unknown>> {
  return {
    schema: opParamsToSchema(descriptor),
    read: (selection) => readModifierParams(descriptor, selection),
    write: (path, value, selection) => {
      const spec = descriptor.params.find((p) => p.name === path);
      if (spec?.widget === 'curve' && spec.curve && isCurveValue(value)) {
        // One write of the curve's value: only the params that differ are set, each through
        // `setModifierParam`, so a drag of one end never touches the others.
        const current = readModifierParams(descriptor, selection)[path] as CurveValue;
        const names = curveParamNames({ ...spec, curve: spec.curve });
        for (const key of CURVE_KEYS) {
          if (value[key] === current[key]) continue;
          useSceneStore
            .getState()
            .setModifierParam(selection.nodeId, selection.modId, names[key], value[key]);
        }
        return;
      }
      useSceneStore
        .getState()
        .setModifierParam(
          selection.nodeId,
          selection.modId,
          path,
          value as number | string | boolean,
        );
    },
  };
}

/** Registers a `modifier:<opType>` scope for every op in the merged registry. Call whenever the ops cache updates. */
export function registerModifierScopes(ops: OpDescriptor[]): void {
  for (const descriptor of ops) {
    registerScope(modifierScopeKey(descriptor.name), buildModifierScope(descriptor));
  }
}
