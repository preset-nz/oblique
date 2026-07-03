import { create } from 'zustand';
import type { BlendMode, Modifier, PixelNode, Scene, SceneNode } from './types';

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
}

interface SceneState {
  scene: Scene;

  /** Insert a new pixel node at the top of the stack (index 0). */
  addPixelNode: (
    partial: Pick<PixelNode, 'sourcePath' | 'sourceSize'> & Partial<PixelNode>,
  ) => string;
  removeNode: (id: string) => void;
  reorderNode: (id: string, toIndex: number) => void;
  setNodeProp: (id: string, patch: NodePropPatch) => void;

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

  markDirty: (nodeId: string, level: 'draft' | 'working') => void;
  clearDirty: (nodeId: string, level: 'draft' | 'working') => void;

  loadScene: (scene: Scene) => void;
}

function updateNode(nodes: SceneNode[], id: string, fn: (node: SceneNode) => SceneNode) {
  return nodes.map((n) => (n.id === id ? fn(n) : n));
}

export const useSceneStore = create<SceneState>((set) => ({
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

  removeNode: (id) => {
    set((s) => ({ scene: { ...s.scene, nodes: s.scene.nodes.filter((n) => n.id !== id) } }));
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
    // Compositing-only mutation (visible/blendMode/opacity/label) — no
    // dirty flag per dirty rule 4.
    set((s) => ({
      scene: { ...s.scene, nodes: updateNode(s.scene.nodes, id, (n) => ({ ...n, ...patch })) },
    }));
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
    set((s) => ({
      scene: {
        ...s.scene,
        nodes: updateNode(s.scene.nodes, nodeId, (n) => ({
          ...n,
          modifiers: n.modifiers.filter((m) => m.id !== modId),
          dirty: dirtyBoth(),
        })),
      },
    }));
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
}));
