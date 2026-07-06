import { pathCommandsFor } from '@/scene/vectorRasterize';
import { usePenAppendTargetId, usePenStateStore } from './penState';
import { commandsToPathD } from './svgPath';

/**
 * Live preview overlay for the in-progress pen path
 * (features/06-vector-nodes/pen-tool.md). Document-space, mounted inside
 * `Viewport.tsx`'s shared `<g transform={overlayMatrix}>` group exactly like
 * the marquee overlays — no view-transform maths of its own beyond scaling
 * screen-constant stroke widths/handle radii, same idiom as
 * `MarqueeBox.tsx`/`LassoMarquee.tsx`.
 *
 * Committed segments are built from the SAME `pathCommandsFor` the
 * rasteriser uses (vectorRasterize.ts) — the preview can never drift from
 * what will actually be filled once the path commits. The rubber-band
 * segment from the last anchor to the live cursor is deliberately a
 * straight line even for a smooth last anchor (story: "rubber-band
 * curvature preview of the incoming handle drag" is out of scope) —
 * Viewport.tsx owns all the pointer events, this component only draws.
 */

const ANCHOR_SCREEN_RADIUS = 4;
const FIRST_ANCHOR_SCREEN_RADIUS = 6;

export interface PenToolProps {
  viewScale: number;
}

export function PenTool({ viewScale }: PenToolProps) {
  const anchors = usePenStateStore((s) => s.anchors);
  const cursor = usePenStateStore((s) => s.cursor);
  // pen-append-to-node.md: while an existing unlocked vector node is
  // selected, a finished shape appends to it rather than starting a new
  // node — tint the live preview with the same accent used elsewhere for
  // "this is the active/selected thing" (PathEditor.tsx's active-anchor
  // fill) so that distinction is legible before the shape commits.
  const appendTargetId = usePenAppendTargetId();
  const previewColor = appendTargetId ? '#f59e0b' : '#38bdf8';

  if (anchors.length === 0) return null;

  const invScale = 1 / Math.max(viewScale, 0.0001);
  const strokeWidth = invScale;
  const committedD = commandsToPathD(pathCommandsFor([{ anchors, closed: false }]));
  const last = anchors[anchors.length - 1];

  return (
    <g data-testid="pen-tool-preview">
      <path d={committedD} fill="none" stroke={previewColor} strokeWidth={strokeWidth} />
      {cursor && (
        <line
          data-testid="pen-tool-rubber-band"
          x1={last.point.x}
          y1={last.point.y}
          x2={cursor.x}
          y2={cursor.y}
          stroke={previewColor}
          strokeWidth={strokeWidth}
          strokeDasharray={`${4 * invScale} ${4 * invScale}`}
        />
      )}
      {anchors.map((a, i) => (
        <circle
          key={`anchor-${a.point.x}-${a.point.y}`}
          cx={a.point.x}
          cy={a.point.y}
          r={(i === 0 ? FIRST_ANCHOR_SCREEN_RADIUS : ANCHOR_SCREEN_RADIUS) * invScale}
          fill={i === 0 ? '#f472b6' : '#38bdf8'}
          stroke="#0c4a6e"
          strokeWidth={strokeWidth}
        />
      ))}
    </g>
  );
}
