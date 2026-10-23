import { isMaskableMarquee, useMarqueeStateStore } from './marquee';
import { useSelectionStore } from './selection';
import { useSceneStore } from './store';

/**
 * Save Selection (save-selection.md): commits the active marquee to a selection node with no
 * modifier. The one entry point Return on the canvas (`Viewport.tsx`) and Select > Save
 * Selection (`app/menu.ts`) both call.
 *
 * Reads the marquee store, bails (returns `undefined`, nothing touched) unless the marquee is
 * maskable, saves it as one scene edit, clears the marquee (which also drops Smart Select's
 * prompt markers through its controller's polygons subscription; the tool stays armed) and
 * selects the new node so the layer list shows where it went. Feather, expand and invert are
 * not saved: they belong to a mask reference, not the shape.
 */
export function saveActiveSelection(): string | undefined {
  const { marquee, clear } = useMarqueeStateStore.getState();
  if (!marquee || !isMaskableMarquee(marquee)) return undefined;
  const id = useSceneStore.getState().saveMarqueeAsSelection(marquee);
  if (!id) return undefined;
  clear();
  useSelectionStore.getState().selectNode(id);
  return id;
}
