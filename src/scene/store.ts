import { create } from 'zustand';
import * as backgroundSource from './backgroundSource';
import * as cache from './cache';
import {
  fillRuleForMarquee,
  type MarqueeShape,
  marqueeToVectorPaths,
  useMarqueeStateStore,
} from './marquee';
import { hasDocumentPinnedMask } from './maskInputs';
import {
  type BlendMode,
  IDENTITY_TRANSFORM_2D,
  isPixelNode,
  isTextNode,
  isVectorNode,
  type Modifier,
  type NodeOutput,
  type PixelNode,
  type Scene,
  type SceneNode,
  type TextNode,
  type Transform2D,
  type VectorMaskRef,
  type VectorNode,
  type VectorPath,
} from './types';

/** Document px a duplicate is offset from its original (x and y), so it doesn't hide exactly underneath it. */
export const DUPLICATE_OFFSET_PX = 16;

function makeEmptyScene(): Scene {
  return {
    id: crypto.randomUUID(),
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [0, 0],
  };
}

function dirtyBoth(): SceneNode['dirty'] {
  return { draft: true, working: true };
}

/**
 * Display label for a text node (text-node-model.md): the first non-blank line,
 * trimmed and cut to 32 characters with a trailing `…`, or `'Text'` when there is none.
 */
export function textLabel(content: string): string {
  const line = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return 'Text';
  const chars = Array.from(line);
  return chars.length > 32 ? `${chars.slice(0, 32).join('')}…` : line;
}

/** The text fields `setTextProps` may change (`output`/`visible` etc. go through `setNodeProp`). */
export type TextPropPatch = Partial<
  Pick<
    TextNode,
    | 'content'
    | 'font'
    | 'fontSize'
    | 'tracking'
    | 'kerning'
    | 'lineHeight'
    | 'align'
    | 'fill'
    | 'stroke'
    | 'position'
  >
>;

export interface NodePropPatch {
  visible?: boolean;
  blendMode?: BlendMode;
  opacity?: number;
  label?: string;
  /**
   * Compositing semantics only — the raster is the same either way
   * (mask-span-scoping.md); no dirty flag, per dirty rule 4, same posture
   * as `visible`/`blendMode`/`opacity`.
   */
  output?: NodeOutput;
}

interface SceneState {
  scene: Scene;

  /**
   * Transient (lock-state-machine.md) — node ids whose full-res bake cook is
   * currently in flight. NOT scene state: never persisted, never touched by
   * undo/redo. Lets a second `lockNode` call on the same node no-op and
   * feeds the future lock-ui.md progress affordance.
   */
  bakingNodeIds: Set<string>;

  /** Insert a new pixel node at the top of the stack (index 0). */
  addPixelNode: (
    partial: Pick<PixelNode, 'sourcePath' | 'sourceSize'> & Partial<PixelNode>,
  ) => string;

  /**
   * Insert a new vector node at the top of the stack (index 0). No
   * `sourcePath`/`sourceSize` — its raster spans `Scene.documentSize`
   * (vector-node-model.md's Sizing note). Dirtied on creation like
   * `addPixelNode` so the scheduler cooks its first raster.
   */
  addVectorNode: (partial: Pick<VectorNode, 'paths' | 'fillRule'> & Partial<VectorNode>) => string;

  /**
   * Insert a new text node at the top of the stack (index 0), the same as
   * `addVectorNode`. Defaults per text-node-model.md; dirtied on creation so the
   * scheduler cooks its first raster.
   */
  addTextNode: (
    partial: Pick<TextNode, 'content' | 'font' | 'position'> & Partial<TextNode>,
  ) => string;

  /**
   * Merges a text-property patch (text-node-model.md). No-op on a missing,
   * non-text or locked node, and on a patch that changes nothing (same state
   * object returned, so history records nothing). Dirties the node and any
   * node whose modifier mask references it. The label follows `content` only
   * while it is still the auto label.
   */
  setTextProps: (nodeId: string, patch: TextPropPatch) => void;

  /**
   * Convert to Outlines (convert-to-outlines.md): replaces a text node, at the
   * same stack index, with a `VectorNode` carrying `paths` (document space,
   * supplied by the caller so the store stays free of IPC) and `fillRule:
   * 'nonzero'`. The new node has a NEW id; `output`, `modifiers` (same ids, so
   * their `maskId`s stay valid), `visible`, `blendMode`, `opacity`, `label` and
   * `transform2d` carry over. Every `maskRefs` entry pointing at the text is
   * repointed to the new id and its consumers are dirtied. One `set()`, so
   * history records one step. Returns the new id, or `null` (state untouched)
   * for a missing, non-text or locked node.
   */
  convertTextToOutlines: (nodeId: string, paths: VectorPath[]) => string | null;

  /**
   * Replaces a vector node's `paths` wholesale (path-editing.md) — one
   * coarse action for the whole story's editing surface: drag an anchor or
   * handle, cycle an anchor's mode, insert an anchor on a segment, delete an
   * anchor. Each completes in a single call on pointerup/click (never
   * per-pointermove), so the always-on history subscription captures one
   * undo step per edit with no `beginTransaction` needed. Dirties the node
   * (raster changes -> recook, dirty rule 1). No-op on a non-vector node id.
   *
   * Cross-node dirty (vector-modifier-masks.md, the epic's first case of
   * editing node A recooking node B): any OTHER node carrying a modifier
   * whose `maskId` resolves to a `maskRefs` entry pointing at this vector
   * node is dirtied too — its own paths/params didn't change, but the
   * rasterised mask plane it cooks with did.
   */
  setVectorPaths: (nodeId: string, paths: VectorPath[]) => void;

  /**
   * Sets a vector node's `fillRule` (vectors-tab.md's node-level control).
   * Same dirty posture as `setVectorPaths` — the fill rule changes how
   * overlapping/self-intersecting paths rasterise, so it's a raster change
   * (dirty rule 1), not a compositing-only toggle like `output`. Shares the
   * cross-node maskRef dirty with `setVectorPaths` (`dirtyMaskRefConsumers`)
   * — any modifier whose live vector mask resolves to this node also
   * recooks. No-op on a non-vector node id.
   */
  setVectorFillRule: (nodeId: string, fillRule: VectorNode['fillRule']) => void;

  /**
   * Bakes the node full-res once and freezes it (lock-state-machine.md): one
   * undoable scene change (`state: 'locked'`), committed only after
   * `cookFullRes` resolves. `cookFullRes` is caller-injected rather than
   * imported here — `cookNodeFullRes` lives in `src/cook/`, and `scene/` must
   * never import `cook/` (architecture's "scene is the bottom" rule; `cook/`
   * already imports this store, so the reverse import would be circular).
   * A production caller (a future UI trigger) wires the real
   * `cookNodeFullRes` in. While the cook is in flight the node id sits in
   * `bakingNodeIds`; a second call on the same (or already-locked) node
   * no-ops. On failure the promise rejects, the node stays `active`, and
   * `bakingNodeIds` is cleared regardless — the caller surfaces the error
   * (same posture as export's own cook-failure handling).
   */
  lockNode: (
    nodeId: string,
    cookFullRes: (nodeId: string) => Promise<ImageBitmap>,
  ) => Promise<void>;

  /**
   * Unlocks a node (lock-state-machine.md): `state: 'active'`, the baked
   * cache slot dropped, both dirty flags set so the normal draft/working
   * cook resumes. Synchronous, undoable like any other mutation. No-op on an
   * already-active (or missing) node id.
   */
  unlockNode: (nodeId: string) => void;

  /**
   * Tier-1 duplicate (duplicate-node.md): an independent copy of the node and
   * its whole modifier stack, inserted at the original's own index (directly
   * above it). Pure scene surgery — the decoded source bitmap is
   * `scene/duplicateNode.ts`'s job. Returns the new node id, or `null` when
   * `id` isn't in the scene.
   */
  duplicateNode: (id: string) => string | null;
  removeNode: (id: string) => void;
  reorderNode: (id: string, toIndex: number) => void;
  setNodeProp: (id: string, patch: NodePropPatch) => void;

  /**
   * Replaces a node's `transform2d` wholesale (move/scale/rotate drag).
   * Compositing-only — no dirty flag, no recook (dirty rule 4 extends to
   * transform2d; node-transform-2d.md).
   */
  setNodeTransform: (id: string, transform2d: Transform2D) => void;

  /** Sets `scene.documentSize`. Compositing-only — no dirty flag (rule 4). */
  setDocumentSize: (size: [number, number]) => void;

  /**
   * Sets/clears the document background colour (background-colour.md).
   * `null` clears back to `undefined` (today's transparent behaviour).
   * Compositing-only — no dirty flag, no recook (dirty rule 4, same posture
   * as `setDocumentSize`): the compositor reads `scene.background` directly
   * on every composite, so toggling it recomposites for free.
   */
  setBackgroundColor: (color: string | null) => void;

  /**
   * Sets the document background to an image (background-image.md).
   * Compositing-only, same posture as `setBackgroundColor`. Scene state only
   * — the caller decodes the file and hands the bitmap to
   * `scene/backgroundSource.ts` (`set`) BEFORE calling this, so the first
   * recomposite after the scene change already has the pixels. `setBackgroundColor`
   * (none/colour) drops the held bitmap.
   */
  setBackgroundImage: (sourcePath: string, sourceSize: [number, number]) => void;

  /**
   * Writes a pixel node's source (image-source.md) — one mutation, so one undo step.
   * `sourcePath` is stored verbatim; `sourceSize`, when given, becomes the node's own.
   * Under rhizome the app's version of this sends `layer.set_source`, and Rust alone decides
   * the fit (the new `transform2d` and the refitted node-space `attachTransform`s, in
   * `src-tauri/src/document/mod.rs`); the update coming back calls THIS with `decided`, what
   * Rust chose, so the store changes once. `decided.maskRefs` replaces those mask refs by id.
   * No fit is computed here. Dirties the node at both levels. No-op for a missing,
   * non-pixel or locked node. The caller owns the source bitmap (`scene/replaceSource.ts`).
   */
  setPixelSource: (
    id: string,
    sourcePath: string,
    sourceSize?: [number, number],
    decided?: { transform2d?: Transform2D; maskRefs?: Record<string, VectorMaskRef> },
  ) => void;

  /**
   * Sets the composition note (composition-note.md). An empty string removes
   * the `note` key so saved files stay clean. Compositing-irrelevant — no
   * dirty flag on any node — but a real, undoable, saveable scene edit.
   */
  setNote: (note: string) => void;

  addModifier: (nodeId: string, type: string, defaults: Modifier['params']) => string;
  removeModifier: (nodeId: string, modId: string) => void;
  reorderModifier: (nodeId: string, modId: string, toIndex: number) => void;
  setModifierParam: (
    nodeId: string,
    modId: string,
    key: string,
    value: number | string | boolean,
  ) => void;
  setModifierEnabled: (nodeId: string, modId: string, enabled: boolean) => void;

  /**
   * Attach (or replace) a modifier's *live* vector mask (vector-modifier-
   * masks.md): `maskId` resolves to a new/reused `Scene.maskRefs` entry
   * pointing at `vectorNodeId`, carrying its own feather/expand/invert.
   * Reuses the modifier's existing maskId when present — replacing a mask
   * is the same dirty/recook path as editing it. Returns the mask id.
   */
  setModifierVectorMask: (
    nodeId: string,
    modId: string,
    vectorNodeId: string,
    ref: Omit<VectorMaskRef, 'id' | 'nodeId'>,
  ) => string;
  /** Detach and delete a modifier's vector mask. */
  removeModifierMask: (nodeId: string, modId: string) => void;
  /**
   * "Follows layer" (mask-follows-node.md): switches a modifier's mask ref
   * between `'node'` (snapshots the consumer's CURRENT transform2d into
   * `attachTransform`) and `'document'` (clears both fields). One `set`, so one
   * history step, and the consumer is dirtied once. No-op (nothing dirtied)
   * when the modifier has no resolvable mask, the ref is already in `space`,
   * or the consumer is locked.
   */
  setMaskSpace: (nodeId: string, modId: string, space: 'document' | 'node') => void;

  /**
   * "Mask from selection" (marquees-as-vectors.md): converts a marquee into
   * a hidden `VectorNode` (`visible: false`, `output: 'image'`, labelled
   * `Selection (rect|ellipse|lasso)`) and attaches it to the modifier as a
   * live `VectorMaskRef` — composing `addVectorNode` + `setModifierVectorMask`
   * plus the replace-cleanup rule below. Same locked-consumer guard as
   * `setModifierVectorMask` (returns `undefined`,
   * nothing mutated, on a locked target).
   *
   * Replace rule: if the modifier already carried a selection-derived vector
   * mask, the PREVIOUS vector node is deleted in the same call iff (a) its
   * label starts with `Selection (` and (b) no other `maskRefs` entry still
   * points at it after the swap — otherwise it's either user-authored or
   * shared, and neither is ours to remove.
   *
   * Does NOT open the history transaction itself — the caller
   * (`StackRow.tsx`) wraps this in `beginTransaction`/`endTransaction` so
   * creation + attach + replace-cleanup land as one undo step, matching how
   * the store stays history-agnostic today.
   */
  applyMarqueeAsVectorMask: (
    nodeId: string,
    modId: string,
    marquee: MarqueeShape,
    params: { featherPx: number; expand: number; invert: boolean },
  ) => { vectorNodeId: string; maskId: string } | undefined;

  markDirty: (nodeId: string, level: 'draft' | 'working') => void;
  clearDirty: (nodeId: string, level: 'draft' | 'working') => void;

  loadScene: (scene: Scene) => void;

  /** Replaces the scene with a fresh empty one (roadmap "New" command). */
  resetScene: () => void;
}

function updateNode(nodes: SceneNode[], id: string, fn: (node: SceneNode) => SceneNode) {
  return nodes.map((n) => (n.id === id ? fn(n) : n));
}

/**
 * The lock-state-machine.md mutation guard, shared by every store action that
 * dirties the cook (modifier add/remove/reorder/param-set/enable-toggle,
 * transform2d changes, path edits, mask apply) — "guard once at the store
 * boundary", not scattered per-callsite in the UI. Compositing-only actions
 * (`setNodeProp`, `reorderNode`) never call this; they stay writable on a
 * locked node per the epic's decision.
 */
function isLocked(nodes: SceneNode[], id: string): boolean {
  return nodes.find((n) => n.id === id)?.state === 'locked';
}

/**
 * Cross-node dirty (vector-modifier-masks.md, shared by `setVectorPaths` and
 * `setVectorFillRule`): any OTHER node carrying a modifier whose `maskId`
 * resolves to a `maskRefs` entry pointing at `vectorNodeId` is dirtied too —
 * its own paths/params didn't change, but the rasterised mask plane it cooks
 * with did.
 */
function dirtyMaskRefConsumers(
  nodes: SceneNode[],
  maskRefs: Scene['maskRefs'],
  vectorNodeId: string,
): SceneNode[] {
  const affectedRefIds = new Set(
    Object.values(maskRefs ?? {})
      .filter((ref) => ref.nodeId === vectorNodeId)
      .map((ref) => ref.id),
  );
  if (affectedRefIds.size === 0) return nodes;
  return nodes.map((n) => {
    if (n.id === vectorNodeId) return n;
    const referencesEditedNode = n.modifiers.some((m) => m.maskId && affectedRefIds.has(m.maskId));
    return referencesEditedNode ? { ...n, dirty: dirtyBoth() } : n;
  });
}

/**
 * Reconciles `Scene.maskRefs` (live vector references, many:1 with a
 * VectorNode allowed) and every node's modifiers' `maskId` in one pass,
 * after any mutation that can orphan one side of that link (deleting a
 * node, a modifier, or a VectorNode a maskRef still points at):
 *
 * 1. Drop `maskRefs` entries no modifier references any more.
 * 2. ALSO drop `maskRefs` entries whose `nodeId` no longer exists —
 *    pruning rather than "keep + warn", because a dangling reference to a
 *    vector node that no longer exists is materially indistinguishable
 *    from no mask at all (the sidecar receives nothing to fill either way),
 *    so silently keeping a broken maskId around is dishonest, not gentle.
 * 3. Clear any modifier's `maskId` that no longer resolves into the
 *    surviving table (this is what actually removes a stale maskId string
 *    from a modifier whose vector-node target was deleted — step 2 alone
 *    only prunes the `maskRefs` table, not the modifier that pointed at it).
 *
 * Returns the same `maskRefs` object reference when nothing was pruned so
 * scene identity is preserved.
 */
function pruneMaskState(
  nodes: SceneNode[],
  maskRefs: Scene['maskRefs'],
): { nodes: SceneNode[]; maskRefs: Scene['maskRefs'] } {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const referenced = new Set<string>();
  for (const node of nodes) {
    for (const modifier of node.modifiers) {
      if (modifier.maskId) referenced.add(modifier.maskId);
    }
  }

  let prunedRefs = maskRefs;
  if (maskRefs) {
    const kept = Object.entries(maskRefs).filter(
      ([id, ref]) => referenced.has(id) && nodeIds.has(ref.nodeId),
    );
    if (kept.length !== Object.keys(maskRefs).length) prunedRefs = Object.fromEntries(kept);
  }

  const clearedNodes = nodes.map((n) => {
    let changed = false;
    const modifiers = n.modifiers.map((m) => {
      if (!m.maskId || prunedRefs?.[m.maskId]) return m;
      changed = true;
      const { maskId: _dropped, ...rest } = m;
      return rest;
    });
    return changed ? { ...n, modifiers } : n;
  });

  return { nodes: clearedNodes, maskRefs: prunedRefs };
}

function copyPath(path: VectorPath): VectorPath {
  return {
    ...path,
    anchors: path.anchors.map((a) => ({
      ...a,
      point: { ...a.point },
      ...(a.handleIn ? { handleIn: { ...a.handleIn } } : {}),
      ...(a.handleOut ? { handleOut: { ...a.handleOut } } : {}),
    })),
  };
}

/**
 * Builds the independent copy for `duplicateNode`: fresh ids throughout, fresh
 * params/path/font objects, masks re-keyed (same shape `nodeId`, new ref id).
 * Returns the extended `maskRefs` table (or the input untouched when no
 * modifier carried a resolvable mask).
 */
function copyNode(
  original: SceneNode,
  newId: string,
  maskRefs: Scene['maskRefs'],
): { node: SceneNode; maskRefs: Scene['maskRefs'] } {
  let nextRefs = maskRefs;
  const modifiers = original.modifiers.map((m): Modifier => {
    const { maskId, ...rest } = m;
    const copy: Modifier = { ...rest, id: crypto.randomUUID(), params: { ...m.params } };
    const ref = maskId ? maskRefs?.[maskId] : undefined;
    if (ref) {
      // Same `nodeId`: both modifiers mask against one shape; feather/expand/invert stay per-ref.
      const newMaskId = crypto.randomUUID();
      // `attachTransform` (node-pinned refs) is copied verbatim — the copy's
      // local frame is the original's, so its mask travels with it — but as
      // a fresh object so the two refs never share one.
      nextRefs = {
        ...nextRefs,
        [newMaskId]: {
          ...ref,
          id: newMaskId,
          ...(ref.attachTransform ? { attachTransform: { ...ref.attachTransform } } : {}),
        },
      };
      copy.maskId = newMaskId;
    }
    return copy; // a dangling maskId is dropped, as pruneMaskState does
  });

  const base = original.transform2d ?? IDENTITY_TRANSFORM_2D;
  const node: SceneNode = {
    ...original,
    id: newId,
    label: `${original.label} copy`,
    state: 'active', // never 'locked': the bake belongs to the original's id
    modifiers,
    transform2d: {
      ...base,
      x: base.x + DUPLICATE_OFFSET_PX,
      y: base.y + DUPLICATE_OFFSET_PX,
    },
    dirty: dirtyBoth(),
  };
  if (isVectorNode(original)) {
    (node as VectorNode).paths = original.paths.map(copyPath);
  } else if (isTextNode(original)) {
    const text = node as TextNode;
    text.font = { ...original.font };
    text.position = { ...original.position };
    text.stroke = original.stroke ? { ...original.stroke } : null;
  } else if (isPixelNode(original)) {
    (node as PixelNode).sourceSize = [...original.sourceSize];
  }
  return { node, maskRefs: nextRefs };
}

export const useSceneStore = create<SceneState>((set, get) => ({
  scene: makeEmptyScene(),
  bakingNodeIds: new Set<string>(),

  lockNode: async (nodeId, cookFullRes) => {
    if (get().bakingNodeIds.has(nodeId)) return; // already baking — no-op
    const node = get().scene.nodes.find((n) => n.id === nodeId);
    if (!node || node.state === 'locked') return;

    set((s) => ({ bakingNodeIds: new Set(s.bakingNodeIds).add(nodeId) }));
    try {
      const bitmap = await cookFullRes(nodeId);
      cache.set(nodeId, 'baked', bitmap);
      set((s) => ({
        scene: {
          ...s.scene,
          nodes: updateNode(s.scene.nodes, nodeId, (n) => ({ ...n, state: 'locked' })),
        },
      }));
    } finally {
      set((s) => {
        const next = new Set(s.bakingNodeIds);
        next.delete(nodeId);
        return { bakingNodeIds: next };
      });
    }
  },

  unlockNode: (nodeId) => {
    set((s) => {
      const target = s.scene.nodes.find((n) => n.id === nodeId);
      if (target?.state !== 'locked') return s;
      cache.clearLevel(nodeId, 'baked');
      return {
        scene: {
          ...s.scene,
          nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
            ...n,
            state: 'active',
            dirty: dirtyBoth(),
          })),
        },
      };
    });
  },

  addPixelNode: (partial) => {
    const id = crypto.randomUUID();
    const node: PixelNode = {
      id,
      label: partial.label ?? 'Layer',
      type: 'pixel',
      state: partial.state ?? 'active',
      output: partial.output ?? 'image',
      transform: partial.transform,
      cameraId: partial.cameraId ?? null,
      modifiers: partial.modifiers ?? [],
      visible: partial.visible ?? true,
      blendMode: partial.blendMode ?? 'normal',
      opacity: partial.opacity ?? 1,
      dirty: dirtyBoth(),
      sourcePath: partial.sourcePath,
      sourceSize: partial.sourceSize,
    };
    set((s) => ({ scene: { ...s.scene, nodes: [node, ...s.scene.nodes] } }));
    return id;
  },

  addVectorNode: (partial) => {
    const id = crypto.randomUUID();
    const node: VectorNode = {
      id,
      label: partial.label ?? 'Vector',
      type: 'vector',
      state: partial.state ?? 'active',
      output: partial.output ?? 'image',
      transform: partial.transform,
      cameraId: partial.cameraId ?? null,
      modifiers: partial.modifiers ?? [],
      visible: partial.visible ?? true,
      blendMode: partial.blendMode ?? 'normal',
      opacity: partial.opacity ?? 1,
      dirty: dirtyBoth(),
      paths: partial.paths,
      fillRule: partial.fillRule,
    };
    set((s) => ({ scene: { ...s.scene, nodes: [node, ...s.scene.nodes] } }));
    return id;
  },

  addTextNode: (partial) => {
    const id = crypto.randomUUID();
    const node: TextNode = {
      id,
      label: partial.label ?? textLabel(partial.content),
      type: 'text',
      state: partial.state ?? 'active',
      output: partial.output ?? 'image',
      transform: partial.transform,
      cameraId: partial.cameraId ?? null,
      modifiers: partial.modifiers ?? [],
      visible: partial.visible ?? true,
      blendMode: partial.blendMode ?? 'normal',
      opacity: partial.opacity ?? 1,
      dirty: dirtyBoth(),
      content: partial.content,
      font: partial.font,
      fontSize: partial.fontSize ?? 72,
      tracking: partial.tracking ?? 0,
      kerning: partial.kerning ?? 100,
      lineHeight: partial.lineHeight ?? 1.2,
      align: partial.align ?? 'left',
      fill: partial.fill === undefined ? '#ffffff' : partial.fill,
      stroke: partial.stroke === undefined ? null : partial.stroke,
      position: partial.position,
    };
    set((s) => ({ scene: { ...s.scene, nodes: [node, ...s.scene.nodes] } }));
    return id;
  },

  setTextProps: (nodeId, patch) => {
    set((s) => {
      const target = s.scene.nodes.find((n) => n.id === nodeId);
      if (target?.type !== 'text') return s;
      if (target.state === 'locked') return s; // guarded (lock-state-machine.md)
      const text = target as TextNode;

      const entries = (Object.entries(patch) as [keyof TextPropPatch, unknown][]).filter(
        ([, value]) => value !== undefined,
      );
      const changed = entries.some(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(text[key]),
      );
      if (!changed) return s;

      const label =
        patch.content !== undefined && text.label === textLabel(text.content)
          ? textLabel(patch.content)
          : text.label;
      const withOwnDirty = updateNode(s.scene.nodes, nodeId, (n) => ({
        ...(n as TextNode),
        ...Object.fromEntries(entries),
        label,
        dirty: dirtyBoth(),
      }));
      const nodes = dirtyMaskRefConsumers(withOwnDirty, s.scene.maskRefs, nodeId);

      return { scene: { ...s.scene, nodes } };
    });
  },

  convertTextToOutlines: (nodeId, paths) => {
    const before = get().scene;
    const index = before.nodes.findIndex((n) => n.id === nodeId);
    const target = before.nodes[index];
    if (target?.type !== 'text' || target.state === 'locked') return null;

    const newId = crypto.randomUUID();
    set((s) => {
      const text = target;
      const vector: VectorNode = {
        id: newId,
        label: text.label,
        type: 'vector',
        state: 'active',
        output: text.output,
        cameraId: text.cameraId ?? null,
        modifiers: text.modifiers,
        visible: text.visible,
        blendMode: text.blendMode,
        opacity: text.opacity,
        ...(text.transform2d ? { transform2d: text.transform2d } : {}),
        dirty: dirtyBoth(),
        paths,
        fillRule: 'nonzero',
      };
      const replaced = s.scene.nodes.map((n, i) => (i === index ? vector : n));

      let maskRefs = s.scene.maskRefs;
      if (maskRefs && Object.values(maskRefs).some((ref) => ref.nodeId === nodeId)) {
        maskRefs = Object.fromEntries(
          Object.entries(maskRefs).map(([id, ref]) => [
            id,
            ref.nodeId === nodeId ? { ...ref, nodeId: newId } : ref,
          ]),
        );
      }
      const nodes = dirtyMaskRefConsumers(replaced, maskRefs, newId);
      return { scene: { ...s.scene, nodes, ...(maskRefs ? { maskRefs } : {}) } };
    });
    return newId;
  },

  setVectorPaths: (nodeId, paths) => {
    set((s) => {
      const target = s.scene.nodes.find((n) => n.id === nodeId);
      if (target?.type !== 'vector') return s;
      if (target.state === 'locked') return s; // path edits guarded (lock-state-machine.md)

      const withOwnDirty = updateNode(s.scene.nodes, nodeId, (n) => ({
        ...(n as VectorNode),
        paths,
        dirty: dirtyBoth(),
      }));
      const nodes = dirtyMaskRefConsumers(withOwnDirty, s.scene.maskRefs, nodeId);

      return { scene: { ...s.scene, nodes } };
    });
  },

  setVectorFillRule: (nodeId, fillRule) => {
    set((s) => {
      const target = s.scene.nodes.find((n) => n.id === nodeId);
      if (target?.type !== 'vector') return s;
      if (target.state === 'locked') return s; // guarded (lock-state-machine.md)

      const withOwnDirty = updateNode(s.scene.nodes, nodeId, (n) => ({
        ...(n as VectorNode),
        fillRule,
        dirty: dirtyBoth(),
      }));
      const nodes = dirtyMaskRefConsumers(withOwnDirty, s.scene.maskRefs, nodeId);

      return { scene: { ...s.scene, nodes } };
    });
  },

  duplicateNode: (id) => {
    const original = get().scene.nodes.find((n) => n.id === id);
    if (!original) return null;
    const newId = crypto.randomUUID();
    set((s) => {
      const index = s.scene.nodes.findIndex((n) => n.id === id);
      const source = s.scene.nodes[index];
      const { node, maskRefs } = copyNode(source, newId, s.scene.maskRefs);
      const nodes = [...s.scene.nodes];
      nodes.splice(index, 0, node);
      return { scene: { ...s.scene, nodes, ...(maskRefs ? { maskRefs } : {}) } };
    });
    return newId;
  },

  removeNode: (id) => {
    set((s) => {
      const nodes = s.scene.nodes.filter((n) => n.id !== id);
      const pruned = pruneMaskState(nodes, s.scene.maskRefs);
      return {
        scene: { ...s.scene, nodes: pruned.nodes, maskRefs: pruned.maskRefs },
      };
    });
  },

  reorderNode: (id, toIndex) => {
    // Compositing-only mutation — order affects the composite, not any
    // node's own cache, so no dirty flag per dirty rule 4.
    set((s) => {
      const nodes = [...s.scene.nodes];
      const fromIndex = nodes.findIndex((n) => n.id === id);
      if (fromIndex === -1) return s;
      const [node] = nodes.splice(fromIndex, 1);
      nodes.splice(toIndex, 0, node);
      return { scene: { ...s.scene, nodes } };
    });
  },

  setNodeProp: (id, patch) => {
    // Compositing-only mutation (visible/blendMode/opacity/label/output) — no
    // dirty flag per dirty rule 4.
    set((s) => ({
      scene: { ...s.scene, nodes: updateNode(s.scene.nodes, id, (n) => ({ ...n, ...patch })) },
    }));
  },

  setNodeTransform: (id, transform2d) => {
    // Compositing-only mutation — no dirty flag per dirty rule 4 (see
    // Transform2D's doc comment in scene/types.ts) — with TWO narrow,
    // deliberate exceptions for vector masks (VectorMaskRef's doc comment):
    // (a) the moved node carries a DOCUMENT-pinned mask — it must
    // re-rasterise in its new frame (node-pinned masks, mask-follows-node.md,
    // read their own attachTransform and travel with the pixels: no recook);
    // (b) the moved node IS a
    // vector node some maskRefs entry points at — every consumer's mask
    // must re-rasterise at the shape's new composited position (same
    // cross-node dirty as setVectorPaths).
    set((s) => {
      if (isLocked(s.scene.nodes, id)) return s; // guarded (lock-state-machine.md)

      const maskRefs = s.scene.maskRefs ?? {};
      const refsAtMovedNode = new Set(
        Object.values(maskRefs)
          .filter((ref) => ref.nodeId === id)
          .map((ref) => ref.id),
      );

      const nodes = s.scene.nodes.map((n) => {
        if (n.id === id) {
          const hasDocPinnedMask = hasDocumentPinnedMask(n.modifiers, (mid) => maskRefs[mid]);
          return hasDocPinnedMask
            ? { ...n, transform2d, dirty: dirtyBoth() }
            : { ...n, transform2d };
        }
        const consumesMovedShape = n.modifiers.some(
          (m) => m.maskId && refsAtMovedNode.has(m.maskId),
        );
        return consumesMovedShape ? { ...n, dirty: dirtyBoth() } : n;
      });
      return { scene: { ...s.scene, nodes } };
    });
  },

  setDocumentSize: (size) => {
    set((s) => ({ scene: { ...s.scene, documentSize: size } }));
  },

  setBackgroundColor: (color) => {
    // Choosing none/colour leaves no image to hold (background-image.md).
    backgroundSource.clear();
    set((s) => ({
      scene: {
        ...s.scene,
        background: color === null ? undefined : { type: 'color', color },
      },
    }));
  },

  setBackgroundImage: (sourcePath, sourceSize) => {
    set((s) => ({
      scene: { ...s.scene, background: { type: 'image', sourcePath, sourceSize } },
    }));
  },

  setPixelSource: (id, sourcePath, sourceSize, decided) => {
    set((s) => {
      const node = s.scene.nodes.find((n) => n.id === id);
      if (!node || !isPixelNode(node) || node.state === 'locked') return s;
      const maskRefs = decided?.maskRefs
        ? { ...s.scene.maskRefs, ...decided.maskRefs }
        : s.scene.maskRefs;
      return {
        scene: {
          ...s.scene,
          ...(maskRefs ? { maskRefs } : {}),
          nodes: updateNode(s.scene.nodes, id, (n) => ({
            ...n,
            sourcePath,
            ...(sourceSize ? { sourceSize } : {}),
            ...(decided?.transform2d ? { transform2d: decided.transform2d } : {}),
            dirty: dirtyBoth(),
          })),
        },
      };
    });
  },

  setNote: (note) => {
    set((s) => {
      if (note === (s.scene.note ?? '')) return s;
      const { note: _previous, ...rest } = s.scene;
      return { scene: note === '' ? rest : { ...rest, note } };
    });
  },

  addModifier: (nodeId, type, defaults) => {
    const modId = crypto.randomUUID();
    const modifier: Modifier = { id: modId, type, enabled: true, params: defaults };
    set((s) => {
      if (isLocked(s.scene.nodes, nodeId)) return s; // guarded (lock-state-machine.md)
      return {
        scene: {
          ...s.scene,
          nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
            ...n,
            modifiers: [...n.modifiers, modifier],
            dirty: dirtyBoth(),
          })),
        },
      };
    });
    return modId;
  },

  removeModifier: (nodeId, modId) => {
    set((s) => {
      if (isLocked(s.scene.nodes, nodeId)) return s; // guarded (lock-state-machine.md)
      const nodes = updateNode(s.scene.nodes, nodeId, (n) => ({
        ...n,
        modifiers: n.modifiers.filter((m) => m.id !== modId),
        dirty: dirtyBoth(),
      }));
      const pruned = pruneMaskState(nodes, s.scene.maskRefs);
      return {
        scene: { ...s.scene, nodes: pruned.nodes, maskRefs: pruned.maskRefs },
      };
    });
  },

  reorderModifier: (nodeId, modId, toIndex) => {
    // Unlike node reorder, modifier order changes the pixel result —
    // dirty per dirty rule 4.
    set((s) => {
      if (isLocked(s.scene.nodes, nodeId)) return s; // guarded (lock-state-machine.md)
      return {
        scene: {
          ...s.scene,
          nodes: updateNode(s.scene.nodes, nodeId, (n) => {
            const modifiers = [...n.modifiers];
            const fromIndex = modifiers.findIndex((m) => m.id === modId);
            if (fromIndex === -1) return n;
            const [modifier] = modifiers.splice(fromIndex, 1);
            modifiers.splice(toIndex, 0, modifier);
            return { ...n, modifiers, dirty: dirtyBoth() };
          }),
        },
      };
    });
  },

  setModifierParam: (nodeId, modId, key, value) => {
    set((s) => {
      if (isLocked(s.scene.nodes, nodeId)) return s; // guarded (lock-state-machine.md)
      return {
        scene: {
          ...s.scene,
          nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
            ...n,
            modifiers: n.modifiers.map((m) =>
              m.id === modId ? { ...m, params: { ...m.params, [key]: value } } : m,
            ),
            dirty: dirtyBoth(),
          })),
        },
      };
    });
  },

  setModifierEnabled: (nodeId, modId, enabled) => {
    // Toggling a modifier changes the pixel result — dirty per dirty rule 4.
    set((s) => {
      if (isLocked(s.scene.nodes, nodeId)) return s; // guarded (lock-state-machine.md)
      return {
        scene: {
          ...s.scene,
          nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
            ...n,
            modifiers: n.modifiers.map((m) => (m.id === modId ? { ...m, enabled } : m)),
            dirty: dirtyBoth(),
          })),
        },
      };
    });
  },

  setModifierVectorMask: (nodeId, modId, vectorNodeId, ref) => {
    // Reuse the existing maskId if the modifier already has one — a
    // replace IS an edit, and keeping the id stable means undo restores
    // land on the same entry. Dirty per rule 4: masking changes the pixel
    // result exactly like a param edit.
    const existing = get()
      .scene.nodes.find((n) => n.id === nodeId)
      ?.modifiers.find((m) => m.id === modId)?.maskId;
    const maskId = existing ?? crypto.randomUUID();
    set((s) => {
      // Guarded on the CONSUMER's lock state (lock-state-machine.md) — the
      // referenced vector node's own lock state is irrelevant here, mirrors
      // every other guard being keyed on the mutated node's target id.
      if (isLocked(s.scene.nodes, nodeId)) return s;
      return {
        scene: {
          ...s.scene,
          maskRefs: {
            ...s.scene.maskRefs,
            [maskId]: { id: maskId, nodeId: vectorNodeId, ...ref },
          },
          nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
            ...n,
            modifiers: n.modifiers.map((m) => (m.id === modId ? { ...m, maskId } : m)),
            dirty: dirtyBoth(),
          })),
        },
      };
    });
    return maskId;
  },

  removeModifierMask: (nodeId, modId) => {
    set((s) => {
      if (isLocked(s.scene.nodes, nodeId)) return s; // guarded (lock-state-machine.md)
      const nodes = updateNode(s.scene.nodes, nodeId, (n) => ({
        ...n,
        modifiers: n.modifiers.map((m) => {
          if (m.id !== modId) return m;
          const { maskId: _dropped, ...rest } = m;
          return rest;
        }),
        dirty: dirtyBoth(),
      }));
      const pruned = pruneMaskState(nodes, s.scene.maskRefs);
      return {
        scene: { ...s.scene, nodes: pruned.nodes, maskRefs: pruned.maskRefs },
      };
    });
  },

  setMaskSpace: (nodeId, modId, space) => {
    set((s) => {
      if (isLocked(s.scene.nodes, nodeId)) return s; // guarded (lock-state-machine.md)
      const consumer = s.scene.nodes.find((n) => n.id === nodeId);
      const maskId = consumer?.modifiers.find((m) => m.id === modId)?.maskId;
      const ref = maskId ? s.scene.maskRefs?.[maskId] : undefined;
      if (!consumer || !maskId || !ref) return s;
      if ((ref.space ?? 'document') === space) return s;

      const { space: _space, attachTransform: _attach, ...base } = ref;
      const next: VectorMaskRef =
        space === 'node'
          ? {
              ...base,
              space: 'node',
              attachTransform: { ...(consumer.transform2d ?? IDENTITY_TRANSFORM_2D) },
            }
          : base;
      return {
        scene: {
          ...s.scene,
          maskRefs: { ...s.scene.maskRefs, [maskId]: next },
          nodes: updateNode(s.scene.nodes, nodeId, (n) => ({ ...n, dirty: dirtyBoth() })),
        },
      };
    });
  },

  applyMarqueeAsVectorMask: (nodeId, modId, marquee, params) => {
    if (isLocked(get().scene.nodes, nodeId)) return undefined;

    // Snapshot what the modifier's mask pointed at BEFORE this call, so the
    // replace-cleanup rule below can tell whether a previously-converted
    // selection node is now orphaned.
    const existingMaskId = get()
      .scene.nodes.find((n) => n.id === nodeId)
      ?.modifiers.find((m) => m.id === modId)?.maskId;
    const previousVectorNodeId = existingMaskId
      ? get().scene.maskRefs?.[existingMaskId]?.nodeId
      : undefined;

    // A `polygons` marquee is produced by more than one tool (Epic 17's
    // `select-smart` and 2b's colour-range-select.md's `select-colour`
    // share the shape) — the shape's own `kind` can't disambiguate their
    // commit labels, so each tool stamps its own `label` on the marquee it
    // writes (`select-smart`'s controller: 'Selection (segment)';
    // `select-colour`'s controller: 'Selection (colour)'); this falls back
    // to `'Selection (segment)'` only for a `polygons` marquee with no
    // label at all (pre-2b callers/tests).
    const label =
      marquee.kind === 'polygons'
        ? (marquee.label ?? 'Selection (segment)')
        : `Selection (${marquee.kind})`;
    const vectorNodeId = get().addVectorNode({
      paths: marqueeToVectorPaths(marquee),
      // evenodd, not nonzero: only `polygons` marquees can carry holes
      // (colour-range-select.md) and `trace.py` is winding-agnostic, so
      // evenodd is the only rule that reliably cuts them — see
      // `fillRuleForMarquee`'s own comment in `scene/marquee.ts`.
      fillRule: fillRuleForMarquee(marquee),
      label,
      visible: false,
      output: 'image',
    });

    // Node-pinned by default (mask-follows-node.md): a selection made on the
    // image belongs to the image, so snapshot the consumer's transform now.
    const consumerTransform = get().scene.nodes.find((n) => n.id === nodeId)?.transform2d;
    const maskId = get().setModifierVectorMask(nodeId, modId, vectorNodeId, {
      featherPx: params.featherPx,
      expand: params.expand,
      invert: params.invert,
      space: 'node',
      attachTransform: { ...(consumerTransform ?? IDENTITY_TRANSFORM_2D) },
    });

    if (previousVectorNodeId && previousVectorNodeId !== vectorNodeId) {
      const s = get();
      const previousNode = s.scene.nodes.find((n) => n.id === previousVectorNodeId);
      const stillReferenced = Object.values(s.scene.maskRefs ?? {}).some(
        (ref) => ref.nodeId === previousVectorNodeId,
      );
      if (previousNode?.label.startsWith('Selection (') && !stillReferenced) {
        get().removeNode(previousVectorNodeId);
      }
    }

    return { vectorNodeId, maskId };
  },

  markDirty: (nodeId, level) => {
    set((s) => ({
      scene: {
        ...s.scene,
        nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
          ...n,
          // Rule 1: dirtying draft also dirties working.
          // Rule 2: dirtying working touches only working.
          dirty: level === 'draft' ? { draft: true, working: true } : { ...n.dirty, working: true },
        })),
      },
    }));
  },

  clearDirty: (nodeId, level) => {
    set((s) => ({
      scene: {
        ...s.scene,
        nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
          ...n,
          dirty: { ...n.dirty, [level]: false },
        })),
      },
    }));
  },

  loadScene: (scene) => {
    // Verbatim — no dirty rewrite. Recook-on-load is the persistence
    // story's job (deferred: project-persistence.md).
    set({ scene });
    // A marquee is transient editing state over the OLD scene; carrying it
    // across a whole-scene swap leaves a selection floating over nothing
    // (Georg, 2026-09-10: Cmd+N mid colour-select). The canvas tool stores
    // clear themselves when their target node disappears (selectShared/
    // clearWhenTargetGone.ts); the marquee store lives here, so this is
    // the one place that can clear it without scene/ importing canvas/.
    useMarqueeStateStore.getState().clear();
  },

  resetScene: () => {
    set({ scene: makeEmptyScene() });
    useMarqueeStateStore.getState().clear();
  },
}));
