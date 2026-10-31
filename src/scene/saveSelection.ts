import { useActiveSelectionStore } from './activeSelection';
import { isMaskableMarquee, useMarqueeStateStore } from './marquee';
import { useSceneStore } from './store';

/**
 * Save Selection (save-selection.md): commits the active marquee to a selection node with no
 * modifier. The one entry point Return on the canvas (`Viewport.tsx`) and Select > Save
 * Selection (`app/menu.ts`) both call.
 *
 * Reads the marquee store, bails (returns `undefined`, nothing touched) unless the marquee is
 * maskable, saves it as one scene edit, clears the marquee (which also drops Smart Select's
 * prompt markers through its controller's polygons subscription; the tool stays armed) and
 * makes the new node the active selection (selections-panel.md), so its tint and outline stay on
 * the canvas where the marquee's were. The node selection is left alone. Feather, expand and invert are
 * not saved: they belong to a mask reference, not the shape.
 */
export function saveActiveSelection(): string | undefined {
  const { marquee, clear } = useMarqueeStateStore.getState();
  if (!marquee || !isMaskableMarquee(marquee)) return undefined;
  const id = useSceneStore.getState().saveMarqueeAsSelection(marquee);
  if (!id) return undefined;
  clear();
  useActiveSelectionStore.getState().activate(id);
  return id;
}
