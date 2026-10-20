import { DASH_SCREEN_PX } from '../marquees/MarqueeBox';
import { closedPolylinePath } from '../marquees/marqueeGeometry';
import { SelectionFill, useSelectionFillInputs } from '../SelectionFill';
import type { SmartSelectBox, SmartSelectPoint } from './state';

/**
 * `select-smart`'s document-space overlay (segment-to-vector.md): the
 * traced polygons preview (marching ants, same visual language as
 * `LassoMarquee`), the box prompt (dashed rect, same style as
 * `MarqueeBox` but not draggable — redraw to change it, per the tool's own
 * "drag replaces" rule), and small point markers (green + positive, red −
 * negative). Read-only — committing/discarding go through the stack row's
 * "Mask from selection" and Escape respectively, same as every other
 * marquee; this component only paints.
 *
 * Colours: point markers get their own (green/red carry real meaning here,
 * unlike the borrowed sky-blue outline), box/polygon strokes copied
 * verbatim from `MarqueeBox`/`LassoMarquee` (roadmap: one colour-pass sweep
 * later, not this story's job).
 */
export interface SmartSelectOverlayProps {
  points: SmartSelectPoint[];
  box: SmartSelectBox | null;
  /** The current polygons preview, document space (mirrors the `polygons` marquee written to `scene/marquee.ts`). */
  polygons: Array<Array<{ x: number; y: number }>>;
  viewScale: number;
}

const POINT_SCREEN_RADIUS = 4;

export function SmartSelectOverlay({ points, box, polygons, viewScale }: SmartSelectOverlayProps) {
  const fillInputs = useSelectionFillInputs();
  const invScale = 1 / Math.max(viewScale, 0.0001);
  const strokeWidth = invScale;
  const dash = `${DASH_SCREEN_PX * invScale} ${DASH_SCREEN_PX * invScale}`;
  const pointRadius = POINT_SCREEN_RADIUS * invScale;
  const markerStroke = 1.5 * invScale;
  // One path for every contour, `evenodd`, so a hole in the selection stays a hole.
  const fillPath = polygons.map(closedPolylinePath).filter(Boolean).join(' ');

  return (
    <g data-testid="smart-select-overlay">
      {fillPath && <SelectionFill d={fillPath} fillRule="evenodd" {...fillInputs} />}
      {polygons.map((polygon, i) => {
        if (polygon.length === 0) return null;
        const d = `${polygon.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')} Z`;
        return (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: polygon contours have no stable identity across requests
            key={i}
            d={d}
            fill="transparent"
            stroke="#38bdf8"
            strokeWidth={strokeWidth}
            strokeDasharray={dash}
          />
        );
      })}

      {box && (
        <rect
          x={Math.min(box.x0, box.x1)}
          y={Math.min(box.y0, box.y1)}
          width={Math.abs(box.x1 - box.x0)}
          height={Math.abs(box.y1 - box.y0)}
          fill="transparent"
          stroke="#38bdf8"
          strokeWidth={strokeWidth}
          strokeDasharray={dash}
        />
      )}

      {points.map((p, i) => {
        const color = p.label === 1 ? '#22c55e' : '#ef4444';
        return (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: points are appended in click order, no other stable identity
            key={i}
          >
            <circle cx={p.x} cy={p.y} r={pointRadius} fill={color} fillOpacity={0.25} />
            {p.label === 1 ? (
              <path
                d={`M${p.x - pointRadius},${p.y} L${p.x + pointRadius},${p.y} M${p.x},${p.y - pointRadius} L${p.x},${p.y + pointRadius}`}
                stroke={color}
                strokeWidth={markerStroke}
              />
            ) : (
              <path
                d={`M${p.x - pointRadius},${p.y} L${p.x + pointRadius},${p.y}`}
                stroke={color}
                strokeWidth={markerStroke}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}
