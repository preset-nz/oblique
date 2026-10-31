import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { VectorNode } from '@/scene/types';
import { menuBindings } from './menu';

/**
 * The command table is Rust's (`src-tauri/src/menu.rs`) and what each command does is here, so
 * the one thing that can silently go wrong is an id on one side and not the other: a menu item
 * that does nothing, or a handler nothing calls. The ids are read out of the Rust source.
 */
const rust = readFileSync(new URL('../../src-tauri/src/menu.rs', import.meta.url), 'utf8');

/** The ids `commands()` declares: `file("file-new", …)`, `item("edit-duplicate", …)` and so on. */
const declared = [
  ...rust.matchAll(/\b(?:file|view|layer|text|select|item|toggle)\(\s*"([a-z.-]+)"/g),
].map((m) => m[1]);

/** Items app-kit builds itself: Settings…, Undo and Redo (File's are below). */
const APP_KITS = ['app.settings', 'edit.undo', 'edit.redo'];

/** File's own commands, which app-kit runs in Rust against the document host. */
const APP_KIT_FILE = ['file-new', 'file-open', 'file-save', 'file-save-as'];

const state = {
  replaceableImage: false,
  savableSelection: false,
  deselectable: false,
  snapToLayers: true,
  selectionFill: true,
  leftPanel: true,
  rightPanel: true,
};

describe('the menu bindings against the command table', () => {
  it('reads the table out of menu.rs', () => {
    expect(declared).toContain('file-import');
    expect(declared).toContain('type-convert-outlines');
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('binds every command Rust declares', () => {
    const bound = Object.keys(menuBindings(state));
    for (const id of declared) expect(bound, `${id} has no binding`).toContain(id);
  });

  it('binds nothing Rust does not declare, but app-kit its own items', () => {
    for (const id of Object.keys(menuBindings(state))) {
      expect([...declared, ...APP_KITS], `${id} is bound but not in the table`).toContain(id);
    }
  });

  it("leaves File's New, Open, Save and Save As to app-kit: neither side has them", () => {
    const bound = Object.keys(menuBindings(state));
    for (const id of APP_KIT_FILE) {
      expect(declared, `${id} is back on Oblique's table`).not.toContain(id);
      expect(bound, `${id} is back in the bindings`).not.toContain(id);
    }
  });

  it('leaves Undo and Redo to app-kit: they run the document host history in Rust', () => {
    const bound = Object.keys(menuBindings(state));
    expect(bound).not.toContain('edit.undo');
    expect(bound).not.toContain('edit.redo');
  });
});

describe('the state the menu shows', () => {
  it('enables Replace Image… only while an unlocked image layer is selected', () => {
    expect(menuBindings({ ...state, replaceableImage: false })['layer-replace-image'].enabled).toBe(
      false,
    );
    expect(menuBindings({ ...state, replaceableImage: true })['layer-replace-image'].enabled).toBe(
      true,
    );
  });

  it('enables Select > Save Selection only while a finished marquee is up, with no chord', () => {
    expect(menuBindings({ ...state, savableSelection: false })['select-save'].enabled).toBe(false);
    expect(menuBindings({ ...state, savableSelection: true })['select-save'].enabled).toBe(true);
    expect(rust).not.toMatch(/"select-save",\s*"CmdOrCtrl/);
  });

  it('runs Save Selection through the shared entry point', async () => {
    const { useMarqueeStateStore } = await import('@/scene/marquee');
    const { useSceneStore } = await import('@/scene/store');
    useSceneStore.getState().resetScene();
    useMarqueeStateStore.getState().setMarquee({ kind: 'rect', rect: { x: 0, y: 0, w: 5, h: 5 } });
    menuBindings({ ...state, savableSelection: true })['select-save'].run?.();
    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);
    expect(useMarqueeStateStore.getState().marquee).toBeNull();
  });

  it('enables Select > Deselect while a marquee or an active selection is up, with no chord', () => {
    expect(menuBindings({ ...state, deselectable: false })['select-deselect'].enabled).toBe(false);
    expect(menuBindings({ ...state, deselectable: true })['select-deselect'].enabled).toBe(true);
    expect(rust).not.toMatch(/"select-deselect",\s*"CmdOrCtrl/);
  });

  it('Deselect clears the marquee and the active selection, and leaves the node selection', async () => {
    const { useMarqueeStateStore } = await import('@/scene/marquee');
    const { useActiveSelectionStore } = await import('@/scene/activeSelection');
    const { useSelectionStore } = await import('@/scene/selection');
    const { useSceneStore } = await import('@/scene/store');
    useSceneStore.getState().resetScene();
    const id = useSceneStore.getState().addVectorNode({
      paths: [{ closed: true, anchors: [{ point: { x: 0, y: 0 } }] }],
      fillRule: 'nonzero',
      role: 'selection',
    });
    useActiveSelectionStore.getState().activate(id);
    useSelectionStore.getState().selectNode(id);
    useMarqueeStateStore.getState().setMarquee({ kind: 'rect', rect: { x: 0, y: 0, w: 5, h: 5 } });
    menuBindings({ ...state, deselectable: true })['select-deselect'].run?.();
    expect(useMarqueeStateStore.getState().marquee).toBeNull();
    expect(useActiveSelectionStore.getState().id).toBeNull();
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: id });
  });

  it('ticks Snap to Layers from the snap store, and a click flips the store', async () => {
    const { useSnapStore } = await import('@/canvas/snapState');
    expect(menuBindings({ ...state, snapToLayers: true })['view-snap-layers'].pressed).toBe(true);
    expect(menuBindings({ ...state, snapToLayers: false })['view-snap-layers'].pressed).toBe(false);
    useSnapStore.getState().setEnabled(true);
    menuBindings(state)['view-snap-layers'].run?.();
    expect(useSnapStore.getState().enabled).toBe(false);
    menuBindings(state)['view-snap-layers'].run?.();
    expect(useSnapStore.getState().enabled).toBe(true);
  });

  it('ticks Show Selection Fill from its store, and a click flips the store', async () => {
    const { useSelectionFillStore } = await import('@/canvas/selectionFillState');
    expect(menuBindings({ ...state, selectionFill: true })['view-selection-fill'].pressed).toBe(
      true,
    );
    expect(menuBindings({ ...state, selectionFill: false })['view-selection-fill'].pressed).toBe(
      false,
    );
    useSelectionFillStore.getState().setEnabled(true);
    menuBindings(state)['view-selection-fill'].run?.();
    expect(useSelectionFillStore.getState().enabled).toBe(false);
    menuBindings(state)['view-selection-fill'].run?.();
    expect(useSelectionFillStore.getState().enabled).toBe(true);
  });
});

describe('the side panels', () => {
  it('tick Show Left and Right Panel from the panel store, and a click flips only its own', async () => {
    const { usePanelStore } = await import('@/app/panelState');
    usePanelStore.setState({ left: true, right: true });
    expect(menuBindings({ ...state, leftPanel: false })['view-left-panel'].pressed).toBe(false);
    expect(menuBindings({ ...state, rightPanel: true })['view-right-panel'].pressed).toBe(true);
    menuBindings(state)['view-left-panel'].run?.();
    expect(usePanelStore.getState()).toMatchObject({ left: false, right: true });
    menuBindings(state)['view-right-panel'].run?.();
    expect(usePanelStore.getState()).toMatchObject({ left: false, right: false });
    menuBindings(state)['view-left-panel'].run?.();
    menuBindings(state)['view-right-panel'].run?.();
    expect(usePanelStore.getState()).toMatchObject({ left: true, right: true });
  });

  it('is view state: it never writes the scene, so there is no undo step', async () => {
    const { usePanelStore } = await import('@/app/panelState');
    const { useSceneStore } = await import('@/scene/store');
    const before = useSceneStore.getState().scene;
    menuBindings(state)['view-left-panel'].run?.();
    menuBindings(state)['view-left-panel'].run?.();
    expect(useSceneStore.getState().scene).toBe(before);
    expect(usePanelStore.getState().left).toBe(true);
  });
});

describe('the Layer menu with saved selections in the stack (selections-panel.md)', () => {
  const run = (id: string) => menuBindings(state)[id].run?.();

  /** Nodes top to bottom: ids starting `sel` are saved selections, the rest layers. */
  async function seed(order: string[], selected: string) {
    const { useSceneStore } = await import('@/scene/store');
    const { useSelectionStore } = await import('@/scene/selection');
    const nodes: VectorNode[] = order.map((id) => ({
      id,
      label: id.startsWith('sel') ? `Selection (${id})` : id,
      type: 'vector',
      state: 'active',
      output: 'image',
      cameraId: null,
      modifiers: [],
      visible: true,
      blendMode: 'normal',
      opacity: 1,
      dirty: { draft: false, working: false },
      paths: [],
      fillRule: 'nonzero',
      ...(id.startsWith('sel') ? { role: 'selection' as const } : {}),
    }));
    useSceneStore.setState({
      scene: {
        id: 's',
        nodes,
        cameras: [],
        defaultCameraId: null,
        resolution: 'working',
        documentSize: [10, 10],
      },
    });
    useSelectionStore.getState().selectNode(selected);
    return () => useSceneStore.getState().scene.nodes.map((n) => n.id);
  }

  it('Bring Forward steps over a selection node instead of swapping with it', async () => {
    const ids = await seed(['sel1', 'a', 'sel2', 'b', 'c'], 'b');
    run('layer-forward'); // b is under a, with sel2 between: it lands above a
    expect(ids()).toEqual(['sel1', 'b', 'a', 'sel2', 'c']);
  });

  it('Send Backward steps over a selection node', async () => {
    const ids = await seed(['a', 'sel1', 'b', 'sel2', 'c'], 'a');
    run('layer-backward');
    expect(ids()).toEqual(['sel1', 'b', 'a', 'sel2', 'c']);
  });

  it('Bring to Front and Send to Back go to the ends of the layers', async () => {
    const ids = await seed(['sel1', 'a', 'b', 'sel2'], 'b');
    run('layer-front');
    expect(ids()).toEqual(['sel1', 'b', 'a', 'sel2']);
    run('layer-back'); // just under the last layer; the selection node below it stays below
    expect(ids()).toEqual(['sel1', 'a', 'b', 'sel2']);
  });

  it('is a no-op at the edge of the layers even with a selection node beyond it', async () => {
    const ids = await seed(['sel1', 'a', 'b'], 'a');
    run('layer-forward');
    expect(ids()).toEqual(['sel1', 'a', 'b']);
  });

  it('does nothing when the selected node is a saved selection (after Edit Shape)', async () => {
    const ids = await seed(['a', 'sel1', 'b'], 'sel1');
    for (const id of ['layer-forward', 'layer-backward', 'layer-front', 'layer-back']) run(id);
    expect(ids()).toEqual(['a', 'sel1', 'b']);
  });
});
