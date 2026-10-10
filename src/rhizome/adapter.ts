/**
 * Oblique's `Scene` and rhizome's tree, both ways (Epic 21 story 1). Pure, so it is checked
 * without the app (adapter.test.ts).
 *
 * The tree, as `src-tauri/src/document/mod.rs` defines it:
 * - `/document/document`: `sceneId`, `documentSize`, `resolution`, `note`, `background`.
 * - `/layers` with the order `stack` (index 0 = top); `/layers/<id>`: a layer named by its
 *   Oblique id. `transform2d` is split into `transform2d.position` / `.scale` / `.rotation`,
 *   and absent unless set.
 * - `/layers/<id>/<modifier id>`: a modifier of type `op.<name>`; `enabled` is its own, every
 *   op param lives under `params.<name>` so it can never meet it.
 * - A modifier's mask is a binding onto its `mask` slot from a vector or text layer.
 *
 * `sceneFromRows` is the adapter the app runs. `rowsFromScene` is the same mapping the other
 * way, as Rust's `add_layer` writes it: a TypeScript statement of the contract, used by the
 * tests and the fake host. It is not what produces the real rows, so a round trip through it
 * only shows that the two TypeScript halves agree; the Rust tests hold the other side.
 */
import type {
  Modifier,
  Scene,
  SceneBackground,
  SceneNode,
  Transform2D,
  VectorMaskRef,
} from '@/scene/types';
import type { Row, Update, View } from './transport';

/** Where an op's params live on a modifier (`param_key` in document/mod.rs). */
export const PARAM_PREFIX = 'params.';

export const DOCUMENT_PATH = '/document/document';
export const LAYERS_PATH = '/layers';
export const layerPath = (id: string): string => `${LAYERS_PATH}/${id}`;

export const val = (r: Row, key: string): unknown => r.values?.[key];
export const isSet = (r: Row, key: string): boolean => r.set?.includes(key) ?? false;

const TEXT_KEYS = [
  'content',
  'font',
  'fontSize',
  'tracking',
  'kerning',
  'lineHeight',
  'align',
  'fill',
  'stroke',
  'position',
] as const;

const LAYER_KEYS = ['label', 'state', 'output', 'visible', 'blendMode', 'opacity'] as const;

/** The layer props a commands-first edit writes (`setNodeProp`'s keys). */
export const PROP_KEYS = ['visible', 'blendMode', 'opacity', 'label', 'output'] as const;

export function transform2d(r: Row): Transform2D | undefined {
  if (
    !['transform2d.position', 'transform2d.scale', 'transform2d.rotation'].some((k) => isSet(r, k))
  )
    return undefined;
  const [x, y] = val(r, 'transform2d.position') as [number, number];
  const [scaleX, scaleY] = val(r, 'transform2d.scale') as [number, number];
  return { x, y, scaleX, scaleY, rotation: val(r, 'transform2d.rotation') as number };
}

/** The tree's value keys for a transform (what a drag writes). */
export function transformChanges(
  at: string,
  t: Transform2D,
): { at: string; key: string; value: unknown }[] {
  return [
    { at, key: 'transform2d.position', value: [t.x, t.y] },
    { at, key: 'transform2d.scale', value: [t.scaleX, t.scaleY] },
    { at, key: 'transform2d.rotation', value: t.rotation },
  ];
}

// ---------------------------------------------------------------- rows -> scene

function modifierFrom(
  rows: Map<string, Row>,
  m: Row,
  maskRefs: Record<string, VectorMaskRef>,
): Modifier {
  const params: Modifier['params'] = {};
  for (const k of m.set ?? [])
    if (k.startsWith(PARAM_PREFIX)) params[k.slice(PARAM_PREFIX.length)] = val(m, k) as never;
  const mod: Modifier = {
    id: m.name,
    type: m.type.replace(/^op\./, ''),
    enabled: val(m, 'enabled') as boolean,
    params,
  };
  const mask = m.bindings?.find((b) => b.on.slot === 'mask');
  if (mask) {
    const v = mask.values ?? {};
    const ref: VectorMaskRef = {
      id: v.refId as string,
      nodeId: rows.get(mask.source)?.name ?? '',
      featherPx: v.featherPx as number,
      expand: v.expand as number,
      invert: v.invert as boolean,
    };
    if (v.space != null) ref.space = v.space as VectorMaskRef['space'];
    if (v.attachTransform != null) ref.attachTransform = v.attachTransform as Transform2D;
    maskRefs[ref.id] = ref;
    mod.maskId = ref.id;
  }
  return mod;
}

export function layerNode(
  rows: Map<string, Row>,
  r: Row,
  maskRefs: Record<string, VectorMaskRef>,
): SceneNode {
  const modifiers = (r.orders?.modifiers ?? []).map((mid) =>
    modifierFrom(rows, rows.get(mid) as Row, maskRefs),
  );
  const node: Record<string, unknown> = {
    id: r.name,
    type: r.type,
    label: val(r, 'label'),
    state: val(r, 'state'),
    output: val(r, 'output'),
    visible: val(r, 'visible'),
    blendMode: val(r, 'blendMode'),
    opacity: val(r, 'opacity'),
    cameraId: null,
    modifiers,
    dirty: { draft: true, working: true },
  };
  const t = transform2d(r);
  if (t) node.transform2d = t;
  if (isSet(r, 'transform')) node.transform = val(r, 'transform');
  if (r.type === 'pixel') {
    node.sourcePath = r.refs?.source?.file ?? '';
    node.sourceSize = val(r, 'sourceSize');
  } else if (r.type === 'vector') {
    node.paths = val(r, 'paths');
    node.fillRule = val(r, 'fillRule');
  } else {
    for (const k of TEXT_KEYS) node[k] = val(r, k);
  }
  return node as unknown as SceneNode;
}

/** The whole scene from rows (by id), or `null` when the document or its layers are missing. */
export function sceneFromRows(rows: Map<string, Row>): Scene | null {
  const all = [...rows.values()];
  const doc = all.find((r) => r.path === DOCUMENT_PATH);
  const layers = all.find((r) => r.path === LAYERS_PATH);
  if (!doc || !layers) return null;
  const maskRefs: Record<string, VectorMaskRef> = {};
  const nodes = (layers.orders?.stack ?? []).map((id) =>
    layerNode(rows, rows.get(id) as Row, maskRefs),
  );
  const s: Scene = {
    id: val(doc, 'sceneId') as string,
    nodes,
    cameras: [],
    defaultCameraId: null,
    resolution: val(doc, 'resolution') as Scene['resolution'],
    documentSize: val(doc, 'documentSize') as [number, number],
    maskRefs,
  };
  if (isSet(doc, 'note')) s.note = val(doc, 'note') as string;
  if (isSet(doc, 'background')) s.background = val(doc, 'background') as SceneBackground;
  return s;
}

// ---------------------------------------------------------------- scene -> rows

const rowId = {
  document: 'row:document',
  layers: 'row:layers',
  layer: (id: string) => `row:layer:${id}`,
  modifier: (layer: string, id: string) => `row:modifier:${layer}:${id}`,
};

function valued(row: Row, key: string, value: unknown): void {
  row.values = { ...row.values, [key]: value };
  row.set = [...(row.set ?? []), key];
}

/** One layer's rows (the layer, then its modifiers), as `add_layer` writes them. */
export function layerRows(node: SceneNode, scene: Scene): Row[] {
  const id = node.id;
  const at = layerPath(id);
  const n = node as unknown as Record<string, unknown>;
  const layer: Row = {
    id: rowId.layer(id),
    path: at,
    name: id,
    type: node.type,
    role: 'node',
    parent: rowId.layers,
  };
  for (const key of LAYER_KEYS) valued(layer, key, n[key]);
  if (node.transform2d) {
    const t = node.transform2d;
    valued(layer, 'transform2d.position', [t.x, t.y]);
    valued(layer, 'transform2d.scale', [t.scaleX, t.scaleY]);
    valued(layer, 'transform2d.rotation', t.rotation);
  }
  if (node.transform) valued(layer, 'transform', node.transform);
  if (node.type === 'pixel') {
    layer.refs = { source: { file: n.sourcePath as string } };
    valued(layer, 'sourceSize', n.sourceSize);
  } else if (node.type === 'vector') {
    valued(layer, 'paths', n.paths);
    valued(layer, 'fillRule', n.fillRule);
  } else {
    for (const k of TEXT_KEYS) valued(layer, k, n[k]);
  }

  const modifiers: Row[] = node.modifiers.map((m) => {
    const row: Row = {
      id: rowId.modifier(id, m.id),
      path: `${at}/${m.id}`,
      name: m.id,
      type: `op.${m.type}`,
      role: 'node',
      parent: layer.id,
    };
    valued(row, 'enabled', m.enabled);
    for (const [k, v] of Object.entries(m.params)) valued(row, `${PARAM_PREFIX}${k}`, v);
    const ref = m.maskId ? scene.maskRefs?.[m.maskId] : undefined;
    if (ref) {
      row.bindings = [
        {
          on: { slot: 'mask' },
          source: rowId.layer(ref.nodeId),
          values: {
            refId: ref.id,
            featherPx: ref.featherPx,
            expand: ref.expand,
            invert: ref.invert,
            ...(ref.space ? { space: ref.space } : {}),
            ...(ref.attachTransform ? { attachTransform: ref.attachTransform } : {}),
          },
        },
      ];
    }
    return row;
  });
  if (modifiers.length > 0) layer.orders = { modifiers: modifiers.map((m) => m.id) };
  return [layer, ...modifiers];
}

/** The `/document/document` and `/layers` rows. */
export function documentRows(scene: Scene): { document: Row; layers: Row } {
  const document: Row = {
    id: rowId.document,
    path: DOCUMENT_PATH,
    name: 'document',
    type: 'document',
    role: 'node',
    parent: null,
    values: {
      sceneId: scene.id,
      documentSize: scene.documentSize,
      resolution: scene.resolution,
    },
    set: ['sceneId', 'documentSize', 'resolution'],
  };
  if (scene.note !== undefined) valued(document, 'note', scene.note);
  if (scene.background) valued(document, 'background', scene.background);
  const layers: Row = {
    id: rowId.layers,
    path: LAYERS_PATH,
    name: 'layers',
    type: 'layers',
    role: 'category',
    parent: null,
    orders: { stack: scene.nodes.map((n) => rowId.layer(n.id)) },
  };
  return { document, layers };
}

export function rowsFromScene(scene: Scene): Map<string, Row> {
  const { document, layers } = documentRows(scene);
  const rows = new Map<string, Row>([
    [document.id, document],
    [layers.id, layers],
  ]);
  for (const node of scene.nodes) for (const r of layerRows(node, scene)) rows.set(r.id, r);
  return rows;
}

// ---------------------------------------------------------------- stack order

/**
 * The `reorderNode(id, to)` calls (splice out, splice in) that turn the layer order `current`
 * into `target`, for the same layers in another order. A move (what `layer.reorder` does) is
 * one call; anything else falls back to placing each layer in turn. Empty when the two lists
 * don't hold the same layers: an add or a remove is not a reorder.
 */
export function reorderMoves(current: string[], target: string[]): { id: string; to: number }[] {
  if (current.length !== target.length || !target.every((id) => current.includes(id))) return [];
  const cur = [...current];
  const moves: { id: string; to: number }[] = [];
  const move = (list: string[], id: string, to: number) => {
    list.splice(list.indexOf(id), 1);
    list.splice(to, 0, id);
  };
  const differs = (k: number) => cur[k] !== target[k];
  const first = cur.findIndex((_, k) => differs(k));
  if (first === -1) return [];
  const last = cur.length - 1 - [...cur].reverse().findIndex((_, k) => differs(cur.length - 1 - k));
  for (const [id, to] of [
    [cur[first], last],
    [cur[last], first],
  ] as const) {
    const trial = [...cur];
    move(trial, id, to);
    if (trial.every((x, k) => x === target[k])) return [{ id, to }];
  }
  for (let k = 0; k < target.length; k++) {
    if (cur[k] === target[k]) continue;
    move(cur, target[k], k);
    moves.push({ id: target[k], to: k });
  }
  return moves;
}

// ---------------------------------------------------------------- the mirror

/** The document as rows, by id (rhizome decision 48): a view, then updates. */
export class Mirror {
  readonly rows = new Map<string, Row>();
  private ids = new Map<string, string>();
  seq = 0;
  generation = 0;

  load(view: View): void {
    this.rows.clear();
    this.ids.clear();
    for (const r of view.rows) this.put(r);
    this.seq = view.seq;
    this.generation = view.generation;
  }

  /** `true` when `u` was next in line and applied; `false` when it is stale or leaves a gap. */
  apply(u: Update): 'applied' | 'stale' | 'gap' {
    if (u.generation !== this.generation || u.seq <= this.seq) return 'stale';
    if (u.seq !== this.seq + 1) return 'gap';
    this.seq = u.seq;
    for (const id of u.removed) this.drop(id);
    for (const r of u.rows) this.put(r);
    return 'applied';
  }

  byPath(path: string): Row | undefined {
    const id = this.ids.get(path);
    return id === undefined ? undefined : this.rows.get(id);
  }

  scene(): Scene | null {
    return sceneFromRows(this.rows);
  }

  private put(r: Row): void {
    const old = this.rows.get(r.id);
    if (old && old.path !== r.path) this.ids.delete(old.path);
    this.rows.set(r.id, r);
    this.ids.set(r.path, r.id);
  }

  private drop(id: string): void {
    const old = this.rows.get(id);
    if (old && this.ids.get(old.path) === id) this.ids.delete(old.path);
    this.rows.delete(id);
  }
}

// ---------------------------------------------------------------- comparing

/**
 * A scene's meaning for the reconcile: no cook state (`dirty`), no scene id (a new document's
 * is rhizome's node id, a fresh store's is a random UUID, and nothing reads it), numbers as
 * numbers, absent and empty `maskRefs` the same.
 */
export function normal(scene: Scene): unknown {
  const s = JSON.parse(JSON.stringify(scene)) as Record<string, unknown>;
  for (const n of s.nodes as Record<string, unknown>[]) delete n.dirty;
  delete s.id;
  s.maskRefs ??= {};
  return s;
}

export function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  if (Object.is(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return `${at}: list vs not`;
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length)
      return `${at}: ${a.length} vs ${b.length} items`;
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const d = firstDifference(x[k], y[k], Array.isArray(a) ? `${at}[${k}]` : `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
