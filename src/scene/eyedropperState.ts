import { create } from 'zustand';

/**
 * Ephemeral UI state for the colour-param eyedropper (eyedropper.md). A
 * colour field's pipette button arms a one-shot pick; the Viewport's next
 * primary pointerdown samples the display composite and calls `pick`, which
 * hands the hex back through `onPick` and disarms. Panels and canvas never
 * import each other (depcruise `panels-canvas-meet-via-stores`), so this
 * store is where they meet.
 *
 * `onPick` is a function held in a UI store — fine, it never enters the
 * scene (which stays JSON-serialisable). `fieldKey` identifies which field
 * armed the pick so only that field's button shows the active state.
 */
export interface ArmedPick {
  fieldKey: string;
  onPick: (hex: string) => void;
}

interface EyedropperStore {
  armed: ArmedPick | null;
  /** Arm a pick. A previous armed pick (from any field) is replaced, not queued. */
  arm: (pick: ArmedPick) => void;
  disarm: () => void;
  /** Delivers `hex` to the armed field's `onPick`, then disarms. No-op when nothing is armed. */
  pick: (hex: string) => void;
}

export const useEyedropperStore = create<EyedropperStore>((set, get) => ({
  armed: null,
  arm: (armed) => set({ armed }),
  disarm: () => set({ armed: null }),
  pick: (hex) => {
    const { armed } = get();
    if (!armed) return;
    // Disarm first so a throwing onPick can't leave the canvas stuck in pick mode.
    set({ armed: null });
    armed.onPick(hex);
  },
}));
