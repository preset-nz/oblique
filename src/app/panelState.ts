import { usePersistedState } from '@preset.nz/preferences';
import { type PanelState, usePanelState } from '@preset.nz/ux-kit';

/**
 * The two side panels' geometry: `{ width, collapsed }` each, remembered across launches
 * (`usePersistedState` over localStorage, keyed `oblique.shell.panel.<side>`), through ux-kit's
 * `usePanelState`, which clamps a stored width to the bounds below.
 *
 * Left is the tree (Layers, Selections), right the properties (`Layout.tsx`); the 48 px tool rail
 * sits outside both. View > Show Left Panel (`Cmd+[`) is the left one, Show Right Panel (`Cmd+]`)
 * the right (menu standard decision 14).
 *
 * View state, not document state: it never touches the scene store, takes no undo step and is
 * not saved in the `.oblique` file.
 */
export const LEFT_PANEL = { default: 240, min: 200, max: 420 };
export const RIGHT_PANEL = { default: 320, min: 280, max: 520 };

/**
 * Both panels' state, called once, in `App`, and handed to `Layout` (the panels) and the menu (the
 * ticks and the toggles): a persisted-state hook is one `useState`, so two callers would each
 * hold their own copy.
 */
export function usePanels() {
  const left = usePanelState(
    usePersistedState<PanelState>('oblique.shell.panel.left', {
      width: LEFT_PANEL.default,
      collapsed: false,
    }),
    LEFT_PANEL,
  );
  const right = usePanelState(
    usePersistedState<PanelState>('oblique.shell.panel.right', {
      width: RIGHT_PANEL.default,
      collapsed: false,
    }),
    RIGHT_PANEL,
  );
  return { left, right };
}

export type Panels = ReturnType<typeof usePanels>;
