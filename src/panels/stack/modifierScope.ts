import {
  type CheckboxFieldDef,
  type FieldDef,
  type NumberFieldDef,
  type PropertySchema,
  registerScope,
  type Scope,
  type SelectFieldDef,
  type SliderFieldDef,
} from '@preset.nz/property-editors';
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
}

export interface ModifierSliderFieldDef extends SliderFieldDef {
  integerStep?: boolean;
}

/** The selected stack row: one modifier instance on one scene node. */
export interface ModifierSelection {
  nodeId: string;
  modId: string;
}

function paramToField(spec: OpParamSpec): FieldDef {
  const base = { id: spec.name, path: spec.name, label: spec.name };

  switch (spec.type) {
    case 'bool':
      return { ...base, kind: 'checkbox' } satisfies CheckboxFieldDef;

    case 'enum':
      return {
        ...base,
        kind: 'select',
        options: (spec.choices ?? []).map((choice) => ({ value: choice, label: choice })),
      } satisfies SelectFieldDef;

    case 'int':
    case 'float': {
      const integerStep = spec.type === 'int';
      const shared = {
        ...base,
        min: spec.min,
        max: spec.max,
        step: spec.step ?? (integerStep ? 1 : 0.1),
        integerStep,
      };
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
        id: descriptor.name,
        title: descriptor.name,
        rows: descriptor.params.map(paramToField),
      },
    ],
  };
}

/** Registry key for a given op type's modifier scope — one scope per op, since each op's schema differs. */
export function modifierScopeKey(opType: string): string {
  return `modifier:${opType}`;
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
