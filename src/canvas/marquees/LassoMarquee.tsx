import { useRef } from 'react';
import { useMarqueeStateStore } from '@/scene/marquee';
import { SelectionFill, useSelectionFillInputs } from '../SelectionFill';
import { DASH_SCREEN_PX } from './MarqueeBox';
import { closedPolylinePath, type Point, translatePoints } from './marqueeGeometry';

/**
 * Lasso marquee overlay (features/05-selection/marquees.md). Freehand path,
 * no handles — `Viewport.tsx` owns the freehand drag (appending points while
 * the tool draws) and the close-on-return-to-start / close-on-release logic
 * (`marqueeGeometry.ts::isNearStart`); this component only renders the path
 * and owns the "drag the closed path to move it" gesture, mirroring
 * `MarqueeBox`'s move-drag but with no resize handles to go with it.
 *
 * Colours copied verbatim from `TransformBox.tsx` (roadmap: one colour-pass
 * sweep later, not this story's job).
 */
export interface LassoMarqueeProps {
  points: Point[];
  closed: boolean;
  viewScale: number;
  toDoc: (clientX: number, clientY: number) => Point;
}

interface DragState {
  startPoints: Point[];
  startPointerDoc: Point;
}

export function LassoMarquee({ points, closed, viewScale, toDoc }: LassoMarqueeProps) {
  const setMarquee = useMarqueeStateStore((s) => s.setMarquee);
  const dragRef = useRef<DragState | null>(null);
  const fillInputs = useSelectionFillInputs();
  const strokeWidth = 1 / Math.max(viewScale, 0.0001);

  if (points.length === 0) return null;

  const d = `${points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')}${closed ? ' Z' : ''}`;

  function startMove(e: React.PointerEvent) {
    if (!closed) return; // only the closed path is draggable (acceptance: "drag-to-move the closed path")
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { startPoints: points, startPointerDoc: toDoc(e.clientX, e.clientY) };

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const doc = toDoc(ev.clientX, ev.clientY);
      const next = translatePoints(drag.startPoints, {
        x: doc.x - drag.startPointerDoc.x,
        y: doc.y - drag.startPointerDoc.y,
      });
      setMarquee({ kind: 'lasso', points: next, closed: true });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <g>
      {/* Closed even mid-draw: the implied last segment back to the start. */}
      <SelectionFill d={closedPolylinePath(points)} {...fillInputs} />
      <path
        data-testid="lasso-marquee"
        d={d}
        fill="transparent"
        stroke="#38bdf8"
        strokeWidth={strokeWidth}
        strokeDasharray={`${DASH_SCREEN_PX * strokeWidth} ${DASH_SCREEN_PX * strokeWidth}`}
        style={{ pointerEvents: closed ? 'auto' : 'none', cursor: closed ? 'move' : 'default' }}
        onPointerDown={startMove}
      />
    </g>
  );
}
