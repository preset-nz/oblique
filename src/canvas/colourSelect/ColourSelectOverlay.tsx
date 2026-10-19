import type { ColourSeed } from '@/ai/sidecarSelectColour';
import { DASH_SCREEN_PX } from '../marquees/MarqueeBox';
import { closedPolylinePath } from '../marquees/marqueeGeometry';
import { SelectionFill } from '../SelectionFill';

/**
 * `select-colour`'s document-space overlay (colour-range-select.md): the
 * traced polygons preview (marching ants, same visual language as
 * `SmartSelectOverlay`/`LassoMarquee`) and the seed markers (green +
 * positive, red − negative — same convention as `SmartSelectOverlay`'s
 * point markers). No box/outline — the wand has neither. Read-only, same
 * posture as `SmartSelectOverlay`: committing/discarding go through the
 * stack row's "Mask from selection" and Escape respectively.
 */
export interface ColourSelectOverlayProps {
  seeds: ColourSeed[];
  polygons: Array<Array<{ x: number; y: number }>>;
  viewScale: number;
}

const POINT_SCREEN_RADIUS = 4;

export function ColourSelectOverlay({ seeds, polygons, viewScale }: ColourSelectOverlayProps) {
  const invScale = 1 / Math.max(viewScale, 0.0001);
  const strokeWidth = invScale;
  const dash = `${DASH_SCREEN_PX * invScale} ${DASH_SCREEN_PX * invScale}`;
  const pointRadius = POINT_SCREEN_RADIUS * invScale;
  const markerStroke = 1.5 * invScale;
  // One path for every contour, `evenodd`, so a hole in the selection stays a hole.
  const fillPath = polygons.map(closedPolylinePath).filter(Boolean).join(' ');

  return (
    <g data-testid="colour-select-overlay">
      {fillPath && <SelectionFill d={fillPath} fillRule="evenodd" />}
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

      {seeds.map((p, i) => {
        const color = p.label === 1 ? '#22c55e' : '#ef4444';
        return (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: seeds are appended in click order, no other stable identity
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
