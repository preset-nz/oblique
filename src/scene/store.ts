import { create } from 'zustand';
import type {
  BlendMode,
  MaskDef,
  Modifier,
  NodeOutput,
  PixelNode,
  Scene,
  SceneNode,
  Transform2D,
  VectorMaskRef,
  VectorNode,
  VectorPath,
} from './types';

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
   * Attach (or replace) a modifier's mask (selection-to-mask.md). Reuses the
   * modifier's existing maskId when present — replacing a mask is the same
   * dirty/recook path as editing it. Returns the mask id.
   */
  setModifierMask: (nodeId: string, modId: string, def: Omit<MaskDef, 'id'>) => string;

  /**
   * Attach (or replace) a modifier's *live* vector mask (vector-modifier-
   * masks.md): `maskId` resolves to a new/reused `Scene.maskRefs` entry
   * pointing at `vectorNodeId`, carrying its own feather/expand/invert.
   * Reuses the modifier's existing maskId when present (same undo-friendly
   * posture as `setModifierMask`) and clears any stale baked-mask entry
   * under that id — switching a modifier from "mask from selection" to
   * "mask from vector node" must not leave an orphaned `MaskDef` shadowing
   * the id. Returns the mask id.
   */
  setModifierVectorMask: (
    nodeId: string,
    modId: string,
    vectorNodeId: string,
    ref: Omit<VectorMaskRef, 'id' | 'nodeId'>,
  ) => string;
  /** Detach and delete a modifier's mask, baked or vector-referenced. */
  removeModifierMask: (nodeId: string, modId: string) => void;

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
 * Reconciles `Scene.masks` (baked, 1:1 with their modifier), `Scene.maskRefs`
 * (live vector references, many:1 with a VectorNode allowed), and every
 * node's modifiers' `maskId` in one pass, after any mutation that can orphan
 * one side of that link (deleting a node, a modifier, or — the story's
 * deletion-policy call — a VectorNode a maskRef still points at):
 *
 * 1. Drop `masks`/`maskRefs` entries no modifier references any more
 *    (unchanged behaviour for `masks`; new for `maskRefs`).
 * 2. ALSO drop `maskRefs` entries whose `nodeId` no longer exists — the
 *    deletion-policy decision: pruning (like `pruneMasks` already did for
 *    baked masks) rather than "keep + warn", because a dangling reference to
 *    a vector node that no longer exists is materially indistinguishable
 *    from no mask at all (the sidecar receives nothing to fill either way),
 *    so silently keeping a broken maskId around is dishonest, not gentle.
 * 3. Clear any modifier's `maskId` that no longer resolves into either
 *    surviving table (this is what actually removes a stale maskId string
 *    from a modifier whose vector-node target was deleted — step 2 alone
 *    only prunes the `maskRefs` table, not the modifier that pointed at it).
 *
 * Returns the same `masks`/`maskRefs` object references when nothing was
 * pruned so scene identity is preserved (existing behaviour for `masks`).
 */
function pruneMaskState(
  nodes: SceneNode[],
  masks: Scene['masks'],
  maskRefs: Scene['maskRefs'],
): { nodes: SceneNode[]; masks: Scene['masks']; maskRefs: Scene['maskRefs'] } {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const referenced = new Set<string>();
  for (const node of nodes) {
    for (const modifier of node.modifiers) {
      if (modifier.maskId) referenced.add(modifier.maskId);
    }
  }

  let prunedMasks = masks;
  if (masks) {
    const kept = Object.entries(masks).filter(([id]) => referenced.has(id));
    if (kept.length !== Object.keys(masks).length) prunedMasks = Object.fromEntries(kept);
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
      if (!m.maskId || prunedMasks?.[m.maskId] || prunedRefs?.[m.maskId]) return m;
      changed = true;
      const { maskId: _dropped, ...rest } = m;
      return rest;
    });
    return changed ? { ...n, modifiers } : n;
  });

  return { nodes: clearedNodes, masks: prunedMasks, maskRefs: prunedRefs };
}

export const useSceneStore = create<SceneState>((set, get) => ({
  scene: makeEmptyScene(),

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

  setVectorPaths: (nodeId, paths) => {
    set((s) => {
      const target = s.scene.nodes.find((n) => n.id === nodeId);
      if (target?.type !== 'vector') return s;

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

      const withOwnDirty = updateNode(s.scene.nodes, nodeId, (n) => ({
        ...(n as VectorNode),
        fillRule,
        dirty: dirtyBoth(),
      }));
      const nodes = dirtyMaskRefConsumers(withOwnDirty, s.scene.maskRefs, nodeId);

      return { scene: { ...s.scene, nodes } };
    });
  },

  removeNode: (id) => {
    set((s) => {
      const nodes = s.scene.nodes.filter((n) => n.id !== id);
      const pruned = pruneMaskState(nodes, s.scene.masks, s.scene.maskRefs);
      return {
        scene: { ...s.scene, nodes: pruned.nodes, masks: pruned.masks, maskRefs: pruned.maskRefs },
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
    // deliberate exceptions for document-pinned vector masks (VectorMaskRef's
    // doc comment): (a) the moved node carries a vector-masked modifier —
    // its mask must re-rasterise in its new frame; (b) the moved node IS a
    // vector node some maskRefs entry points at — every consumer's mask
    // must re-rasterise at the shape's new composited position (same
    // cross-node dirty as setVectorPaths).
    set((s) => {
      const maskRefs = s.scene.maskRefs ?? {};
      const refsAtMovedNode = new Set(
        Object.values(maskRefs)
          .filter((ref) => ref.nodeId === id)
          .map((ref) => ref.id),
      );

      const nodes = s.scene.nodes.map((n) => {
        if (n.id === id) {
          const hasVectorMask = n.modifiers.some((m) => m.maskId && maskRefs[m.maskId]);
          return hasVectorMask ? { ...n, transform2d, dirty: dirtyBoth() } : { ...n, transform2d };
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

  addModifier: (nodeId, type, defaults) => {
    const modId = crypto.randomUUID();
    const modifier: Modifier = { id: modId, type, enabled: true, params: defaults };
    set((s) => ({
      scene: {
        ...s.scene,
        nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
          ...n,
          modifiers: [...n.modifiers, modifier],
          dirty: dirtyBoth(),
        })),
      },
    }));
    return modId;
  },

  removeModifier: (nodeId, modId) => {
    set((s) => {
      const nodes = updateNode(s.scene.nodes, nodeId, (n) => ({
        ...n,
        modifiers: n.modifiers.filter((m) => m.id !== modId),
        dirty: dirtyBoth(),
      }));
      const pruned = pruneMaskState(nodes, s.scene.masks, s.scene.maskRefs);
      return {
        scene: { ...s.scene, nodes: pruned.nodes, masks: pruned.masks, maskRefs: pruned.maskRefs },
      };
    });
  },

  reorderModifier: (nodeId, modId, toIndex) => {
    // Unlike node reorder, modifier order changes the pixel result —
    // dirty per dirty rule 4.
    set((s) => ({
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
    }));
  },

  setModifierParam: (nodeId, modId, key, value) => {
    set((s) => ({
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
    }));
  },

  setModifierEnabled: (nodeId, modId, enabled) => {
    // Toggling a modifier changes the pixel result — dirty per dirty rule 4.
    set((s) => ({
      scene: {
        ...s.scene,
        nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
          ...n,
          modifiers: n.modifiers.map((m) => (m.id === modId ? { ...m, enabled } : m)),
          dirty: dirtyBoth(),
        })),
      },
    }));
  },

  setModifierMask: (nodeId, modId, def) => {
    // Reuse the existing maskId if the modifier already has one — a
    // replace IS an edit, and keeping the id stable means undo restores
    // land on the same entry. Dirty per rule 4: masking changes the pixel
    // result exactly like a param edit.
    const existing = get()
      .scene.nodes.find((n) => n.id === nodeId)
      ?.modifiers.find((m) => m.id === modId)?.maskId;
    const maskId = existing ?? crypto.randomUUID();
    set((s) => {
      // Clear a stale maskRefs entry under this id — switching a modifier
      // from vector-referenced to baked must not leave the old vector
      // reference shadowed-but-alive under the same id. No-op (preserves
      // `undefined` identity) when there's no maskRefs table yet.
      const maskRefs = s.scene.maskRefs?.[maskId] ? { ...s.scene.maskRefs } : s.scene.maskRefs;
      if (maskRefs) delete maskRefs[maskId];
      return {
        scene: {
          ...s.scene,
          masks: { ...s.scene.masks, [maskId]: { ...def, id: maskId } },
          maskRefs,
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

  setModifierVectorMask: (nodeId, modId, vectorNodeId, ref) => {
    // Same reuse-the-existing-id posture as setModifierMask, mirrored.
    const existing = get()
      .scene.nodes.find((n) => n.id === nodeId)
      ?.modifiers.find((m) => m.id === modId)?.maskId;
    const maskId = existing ?? crypto.randomUUID();
    set((s) => {
      // Clear a stale baked-mask entry under this id — switching a modifier
      // from baked to vector-referenced must not leave the old MaskDef
      // shadowed-but-alive under the same id. No-op (preserves `undefined`
      // identity) when there's no masks table yet.
      const masks = s.scene.masks?.[maskId] ? { ...s.scene.masks } : s.scene.masks;
      if (masks) delete masks[maskId];
      return {
        scene: {
          ...s.scene,
          masks,
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
      const nodes = updateNode(s.scene.nodes, nodeId, (n) => ({
        ...n,
        modifiers: n.modifiers.map((m) => {
          if (m.id !== modId) return m;
          const { maskId: _dropped, ...rest } = m;
          return rest;
        }),
        dirty: dirtyBoth(),
      }));
      const pruned = pruneMaskState(nodes, s.scene.masks, s.scene.maskRefs);
      return {
        scene: { ...s.scene, nodes: pruned.nodes, masks: pruned.masks, maskRefs: pruned.maskRefs },
      };
    });
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
  },

  resetScene: () => {
    set({ scene: makeEmptyScene() });
  },
}));
