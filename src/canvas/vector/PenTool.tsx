import { pathCommandsFor } from '@/scene/vectorRasterize';
import { usePenStateStore } from './penState';

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

function commandToPathD(cmd: ReturnType<typeof pathCommandsFor>[number]): string {
  switch (cmd.op) {
    case 'moveTo':
      return `M${cmd.to.x},${cmd.to.y}`;
    case 'lineTo':
      return `L${cmd.to.x},${cmd.to.y}`;
    case 'bezierCurveTo':
      return `C${cmd.c1.x},${cmd.c1.y} ${cmd.c2.x},${cmd.c2.y} ${cmd.to.x},${cmd.to.y}`;
    case 'closePath':
      return 'Z';
  }
}

function commandsToPathD(commands: ReturnType<typeof pathCommandsFor>): string {
  return commands.map(commandToPathD).join(' ');
}

export function PenTool({ viewScale }: PenToolProps) {
  const anchors = usePenStateStore((s) => s.anchors);
  const cursor = usePenStateStore((s) => s.cursor);

  if (anchors.length === 0) return null;

  const invScale = 1 / Math.max(viewScale, 0.0001);
  const strokeWidth = invScale;
  const committedD = commandsToPathD(pathCommandsFor([{ anchors, closed: false }]));
  const last = anchors[anchors.length - 1];

  return (
    <g data-testid="pen-tool-preview">
      <path d={committedD} fill="none" stroke="#38bdf8" strokeWidth={strokeWidth} />
      {cursor && (
        <line
          data-testid="pen-tool-rubber-band"
          x1={last.point.x}
          y1={last.point.y}
          x2={cursor.x}
          y2={cursor.y}
          stroke="#38bdf8"
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
