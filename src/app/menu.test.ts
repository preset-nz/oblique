import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { menuBindings } from './menu';

/**
 * The command table is Rust's (`src-tauri/src/menu.rs`) and what each command does is here, so
 * the one thing that can silently go wrong is an id on one side and not the other: a menu item
 * that does nothing, or a handler nothing calls. The ids are read out of the Rust source.
 */
const rust = readFileSync(new URL('../../src-tauri/src/menu.rs', import.meta.url), 'utf8');

/** The ids `commands()` declares: `file("file-new", …)`, `item("edit-duplicate", …)` and so on. */
const declared = [...rust.matchAll(/\b(?:file|view|layer|text|item|toggle)\(\s*"([a-z.-]+)"/g)].map(
  (m) => m[1],
);

/** Items app-kit builds itself: Settings…, Undo and Redo. */
const APP_KITS = ['app.settings', 'edit.undo', 'edit.redo'];

const state = { replaceableImage: false, snapToLayers: true };

describe('the menu bindings against the command table', () => {
  it('reads the table out of menu.rs', () => {
    expect(declared).toContain('file-new');
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
});
