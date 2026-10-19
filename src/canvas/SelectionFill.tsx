import {
  SELECTION_FILL_COLOUR,
  SELECTION_FILL_OPACITY,
  useSelectionFillStore,
} from './selectionFillState';

export interface SelectionFillProps {
  /** Path data in document space; every sub-path of a selection goes in one `d` so `evenodd` can cut holes. */
  d: string;
  fillRule?: 'nonzero' | 'evenodd';
}

/**
 * The translucent fill under a selection outline (selection-fill-overlay.md). Another `<path>` in
 * the overlay's own SVG, so the shared `viewTransform` on the parent `<g>` places it; there is no
 * canvas paint. Render it before the outline so the outline stays on top. `pointer-events: none`
 * so it never catches a click. Renders nothing while View -> Show Selection Fill is off.
 */
export function SelectionFill({ d, fillRule = 'nonzero' }: SelectionFillProps) {
  const enabled = useSelectionFillStore((s) => s.enabled);
  if (!enabled) return null;
  return (
    <path
      data-selection-fill=""
      d={d}
      fill={SELECTION_FILL_COLOUR}
      fillOpacity={SELECTION_FILL_OPACITY}
      fillRule={fillRule}
      stroke="none"
      style={{ pointerEvents: 'none' }}
    />
  );
}
