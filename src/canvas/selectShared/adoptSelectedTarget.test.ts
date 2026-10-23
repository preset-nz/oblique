import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useColourSelectStore } from '@/canvas/colourSelect/state';
import { adoptSelectedTarget } from '@/canvas/selectShared/adoptSelectedTarget';
import { useSmartSelectStore } from '@/canvas/smartSelect/state';
import { useToolStateStore } from '@/canvas/toolState';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';

function harness(initial: { target: string | null; armed: boolean }) {
  const state = { target: initial.target, armed: initial.armed };
  const setTarget = vi.fn((id: string) => {
    state.target = id;
  });
  const setStatus = vi.fn();
  const off = adoptSelectedTarget({
    getTargetNodeId: () => state.target,
    setTarget,
    setStatus,
    isArmed: () => state.armed,
  });
  return { state, setTarget, setStatus, off };
}

describe('adoptSelectedTarget', () => {
  let off: (() => void) | null = null;

  beforeEach(() => {
    useSceneStore.getState().resetScene();
    useSelectionStore.getState().clear();
    useToolStateStore.getState().setTool('pan');
    useSmartSelectStore.getState().clear();
    useColourSelectStore.getState().clear();
  });

  afterEach(() => {
    off?.();
    off = null;
  });

  it('adopts the selected pixel node when armed with no target, and resets status to idle', () => {
    const id = useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [4, 4] });
    const h = harness({ target: null, armed: true });
    off = h.off;

    useSelectionStore.getState().selectNode(id);

    expect(h.setTarget).toHaveBeenCalledExactlyOnceWith(id);
    expect(h.setStatus).toHaveBeenCalledExactlyOnceWith('idle');
  });

  it('adopts vector and text nodes too', () => {
    const scene = useSceneStore.getState();
    const vector = scene.addVectorNode({ paths: [], fillRule: 'nonzero' } as never);
    const h = harness({ target: null, armed: true });
    off = h.off;
    useSelectionStore.getState().selectNode(vector);
    expect(h.setTarget).toHaveBeenCalledWith(vector);
  });

  it('ignores a selection change when a target already exists', () => {
    const a = useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [4, 4] });
    const b = useSceneStore.getState().addPixelNode({ sourcePath: '/b.png', sourceSize: [4, 4] });
    const h = harness({ target: a, armed: true });
    off = h.off;

    useSelectionStore.getState().selectNode(b);

    expect(h.setTarget).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("ignores a selection when the tool isn't armed", () => {
    const id = useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [4, 4] });
    const h = harness({ target: null, armed: false });
    off = h.off;

    useSelectionStore.getState().selectNode(id);

    expect(h.setTarget).not.toHaveBeenCalled();
  });

  it('ignores kind: none and node kinds the tools cannot segment', () => {
    const id = useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [4, 4] });
    useSelectionStore.getState().selectNode(id);
    const h = harness({ target: null, armed: true });
    off = h.off;

    useSelectionStore.getState().clear();
    expect(h.setTarget).not.toHaveBeenCalled();

    // A node id that isn't in the scene (deleted, or a non-segmentable kind).
    useSelectionStore.getState().selectNode('missing');
    expect(h.setTarget).not.toHaveBeenCalled();

    // A mesh node: present in the scene but not segmentable.
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [...s.scene.nodes, { ...s.scene.nodes[0], id: 'mesh-1', type: 'mesh' } as never],
      },
    }));
    useSelectionStore.getState().selectNode('mesh-1');
    expect(h.setTarget).not.toHaveBeenCalled();
  });

  describe('installed on the real stores', () => {
    it('Smart Select armed with an error status adopts the next selected layer and goes idle', () => {
      const id = useSceneStore
        .getState()
        .addPixelNode({ sourcePath: '/a.png', sourceSize: [4, 4] });
      useToolStateStore.getState().setTool('select-smart');
      useSmartSelectStore.getState().setTarget(null);
      useSmartSelectStore
        .getState()
        .setStatus('error', 'Select an image or vector layer to segment');

      useSelectionStore.getState().selectNode(id);

      expect(useSmartSelectStore.getState().targetNodeId).toBe(id);
      expect(useSmartSelectStore.getState().status).toBe('idle');
      expect(useSmartSelectStore.getState().error).toBeNull();
      // Colour Select isn't the active tool, so it stays out of it.
      expect(useColourSelectStore.getState().targetNodeId).toBeNull();
    });

    it('Colour Select armed adopts too, keeping its params', () => {
      const id = useSceneStore
        .getState()
        .addPixelNode({ sourcePath: '/a.png', sourceSize: [4, 4] });
      useToolStateStore.getState().setTool('select-colour');
      useColourSelectStore.getState().setParams({ tolerance: 42 });
      useColourSelectStore
        .getState()
        .setStatus('error', 'Select an image or vector layer to select from');

      useSelectionStore.getState().selectNode(id);

      expect(useColourSelectStore.getState().targetNodeId).toBe(id);
      expect(useColourSelectStore.getState().status).toBe('idle');
      expect(useColourSelectStore.getState().params.tolerance).toBe(42);
      expect(useSmartSelectStore.getState().targetNodeId).toBeNull();
    });

    it('Smart Select armed against A does not follow a selection of B', () => {
      const a = useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [4, 4] });
      const b = useSceneStore.getState().addPixelNode({ sourcePath: '/b.png', sourceSize: [4, 4] });
      useToolStateStore.getState().setTool('select-smart');
      useSmartSelectStore.getState().setTarget(a);

      useSelectionStore.getState().selectNode(b);

      expect(useSmartSelectStore.getState().targetNodeId).toBe(a);
    });
  });
});
