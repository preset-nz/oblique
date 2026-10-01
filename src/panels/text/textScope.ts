import {
  type NumberFieldDef,
  type PropertySchema,
  registerScope,
  type Scope,
  type SelectFieldDef,
} from '@preset.nz/facets';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import { resolveFont } from '@/fonts/resolveFont';
import { type FontFace, type FontRef, fontRefOf } from '@/fonts/types';
import { type TextPropPatch, useSceneStore } from '@/scene/store';
import { isTextNode, type TextNode } from '@/scene/types';

/**
 * The `text-node` facets scope (text-tool-and-inspector.md), following the
 * `modifierScope.ts` pattern: a schema, a flat `read` (facets resolves `path`
 * as a plain key lookup, so nested fields use dotted keys), and a `write` that
 * turns a path + value into a `setTextProps` patch. The path -> patch mapping
 * is a pure function (`textPatchFor`) so it can be unit-tested; every write
 * goes through `setTextProps`, which is the only thing that mutates the node.
 */

export const TEXT_SCOPE_KEY = 'text-node';

/** A stroke that gets switched on from nothing starts here. */
export const DEFAULT_STROKE = { color: '#000000', width: 2 } as const;

/** What the panel's `selection` is: just the node. */
export interface TextSelection {
  nodeId: string;
}

/**
 * The panel's `ctx`. The font renderers need the node's whole `FontRef` (the
 * Style select is keyed by PostScript name), which a flat `value` can't carry.
 */
export interface TextScopeContext {
  font: FontRef;
}

/** Extra props the number renderer reads (see `modifierFieldRenderers.tsx`): a tooltip. */
export interface TextNumberFieldDef extends NumberFieldDef {
  hint?: string;
}

/** `optional-colour` (see `fontFieldRenderers.tsx`): a colour with a "None" checkbox. */
// A `type` alias (not an interface) so it is assignable to facets' open `CustomFieldDef`.
export type OptionalColourFieldDef = {
  kind: 'optional-colour';
  id: string;
  label?: string;
  path: string;
  /** What "None" -> unchecked restores when no colour has been seen yet. */
  fallback: string;
};

const NUMBER_LIMITS: Record<string, readonly [min: number, max: number]> = {
  fontSize: [1, 2000],
  tracking: [-500, 2000],
  lineHeight: [0.5, 4],
  'stroke.width': [0, 200],
};

const ALIGN_VALUES: readonly TextNode['align'][] = ['left', 'center', 'right'];

export const TEXT_SCHEMA: PropertySchema = {
  version: 1,
  groups: [
    {
      id: 'text',
      rows: [
        { kind: 'font-family', id: 'font.family', label: 'Font', path: 'font.family' },
        { kind: 'font-style', id: 'font.style', label: 'Style', path: 'font.style' },
        {
          kind: 'number',
          id: 'fontSize',
          label: 'Size',
          path: 'fontSize',
          min: NUMBER_LIMITS.fontSize[0],
          max: NUMBER_LIMITS.fontSize[1],
          step: 1,
        } satisfies TextNumberFieldDef,
        {
          kind: 'number',
          id: 'tracking',
          label: 'Tracking',
          path: 'tracking',
          min: NUMBER_LIMITS.tracking[0],
          max: NUMBER_LIMITS.tracking[1],
          step: 5,
          hint: '1/1000 em',
        } satisfies TextNumberFieldDef,
        { kind: 'checkbox', id: 'kerning', label: 'Kerning', path: 'kerning' },
        {
          kind: 'number',
          id: 'lineHeight',
          label: 'Line height',
          path: 'lineHeight',
          min: NUMBER_LIMITS.lineHeight[0],
          max: NUMBER_LIMITS.lineHeight[1],
          step: 0.05,
        } satisfies TextNumberFieldDef,
        {
          kind: 'select',
          id: 'align',
          label: 'Align',
          path: 'align',
          options: [
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ],
        } satisfies SelectFieldDef,
        {
          kind: 'optional-colour',
          id: 'fill',
          label: 'Fill',
          path: 'fill',
          fallback: '#ffffff',
        } satisfies OptionalColourFieldDef,
        {
          kind: 'optional-colour',
          id: 'stroke.color',
          label: 'Stroke',
          path: 'stroke.color',
          fallback: DEFAULT_STROKE.color,
        } satisfies OptionalColourFieldDef,
        {
          kind: 'number',
          id: 'stroke.width',
          label: 'Stroke width',
          path: 'stroke.width',
          min: NUMBER_LIMITS['stroke.width'][0],
          max: NUMBER_LIMITS['stroke.width'][1],
          step: 0.5,
        } satisfies TextNumberFieldDef,
      ],
    },
  ],
};

const clamp = (path: string, n: number): number => {
  const [min, max] = NUMBER_LIMITS[path];
  return Math.min(max, Math.max(min, n));
};

/** Faces of one family (case-insensitive, same rule as `resolveFont`). */
function facesOfFamily(faces: FontFace[], family: string): FontFace[] {
  const key = family.toLowerCase();
  return faces.filter((f) => f.family.toLowerCase() === key);
}

/**
 * Picking a family keeps the closest style. An exact style-name match in the
 * new family wins first (Bold -> Bold), because `resolveFont` alone scores
 * only weight/italic and would break a Bold-vs-Condensed-Bold tie (both 700)
 * by PostScript name. Anything else falls to `resolveFont` over just that
 * family's faces (nearest weight, italic preserved where possible).
 */
export function fontForFamily(current: FontRef, family: string, faces: FontFace[]): FontRef | null {
  const inFamily = facesOfFamily(faces, family);
  if (inFamily.length === 0) return null;
  const sameStyle = inFamily.find((f) => f.style.toLowerCase() === current.style.toLowerCase());
  if (sameStyle) return fontRefOf(sameStyle);
  const hit = resolveFont({ ...current, family }, inFamily);
  return hit ? fontRefOf(hit.face) : null;
}

/**
 * Maps one panel write to a `setTextProps` patch, or `null` for an
 * unusable value. Pure: never mutates `node`; rebuilds `stroke` and `font`.
 *
 * - `font.family`: value is the family name (see `fontForFamily`).
 * - `font.style`: value is the chosen face's PostScript name (a style name
 *   isn't guaranteed unique within a family), looked up in `faces`.
 * - `stroke.color`: `null` switches the stroke off; a colour switches it on
 *   (with `DEFAULT_STROKE`'s width when it was off) or recolours it.
 * - `stroke.width`: switches the stroke on with `DEFAULT_STROKE`'s colour when it was off.
 */
export function textPatchFor(
  node: TextNode,
  path: string,
  value: unknown,
  faces: FontFace[],
): TextPropPatch | null {
  switch (path) {
    case 'font.family': {
      if (typeof value !== 'string') return null;
      const font = fontForFamily(node.font, value, faces);
      return font ? { font } : null;
    }
    case 'font.style': {
      if (typeof value !== 'string') return null;
      const face = facesOfFamily(faces, node.font.family).find((f) => f.postscriptName === value);
      return face ? { font: fontRefOf(face) } : null;
    }
    case 'fontSize':
    case 'tracking':
    case 'lineHeight': {
      if (typeof value !== 'number' || Number.isNaN(value)) return null;
      return { [path]: clamp(path, value) };
    }
    case 'kerning':
      return typeof value === 'boolean' ? { kerning: value } : null;
    case 'align':
      return ALIGN_VALUES.includes(value as TextNode['align'])
        ? { align: value as TextNode['align'] }
        : null;
    case 'fill':
      return value === null || typeof value === 'string' ? { fill: value } : null;
    case 'stroke.color': {
      if (value === null) return { stroke: null };
      if (typeof value !== 'string') return null;
      return { stroke: { ...(node.stroke ?? DEFAULT_STROKE), color: value } };
    }
    case 'stroke.width': {
      if (typeof value !== 'number' || Number.isNaN(value)) return null;
      return { stroke: { ...(node.stroke ?? DEFAULT_STROKE), width: clamp(path, value) } };
    }
    default:
      return null;
  }
}

/** The flat record facets reads (`path` is a key lookup, so nested fields use dotted keys). */
export function readTextValues(node: TextNode): Record<string, unknown> {
  return {
    'font.family': node.font.family,
    'font.style': node.font.style,
    fontSize: node.fontSize,
    tracking: node.tracking,
    kerning: node.kerning,
    lineHeight: node.lineHeight,
    align: node.align,
    fill: node.fill,
    'stroke.color': node.stroke?.color ?? null,
    'stroke.width': node.stroke?.width ?? DEFAULT_STROKE.width,
  };
}

type StyleListener = (patch: { font?: FontRef; fontSize?: number }) => void;
let styleListener: StyleListener | null = null;

/**
 * Called after a panel write that changes the font or size. `panels/` can't
 * import `canvas/` (depcruise), so the text tool's `lastUsedFont`/`lastUsedSize`
 * (`canvas/text/textEditState.ts`) are fed by `App.tsx` registering a listener.
 */
export function setTextStyleListener(listener: StyleListener | null): void {
  styleListener = listener;
}

function findTextNode(nodeId: string): TextNode | undefined {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  return node && isTextNode(node) ? node : undefined;
}

export const textScope: Scope<TextSelection, Record<string, unknown>> = {
  schema: TEXT_SCHEMA,
  read: (selection) => {
    const node = findTextNode(selection.nodeId);
    return node ? readTextValues(node) : {};
  },
  write: (path, value, selection) => {
    const node = findTextNode(selection.nodeId);
    if (!node) return;
    const patch = textPatchFor(node, path, value, useFontCatalogueStore.getState().faces);
    if (!patch) return;
    useSceneStore.getState().setTextProps(node.id, patch);
    if (patch.font || patch.fontSize !== undefined) {
      styleListener?.({ font: patch.font, fontSize: patch.fontSize });
    }
  },
};

/** Registers the `text-node` scope. Idempotent. */
export function registerTextScope(): void {
  registerScope(TEXT_SCOPE_KEY, textScope);
}
