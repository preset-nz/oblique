import { useRef } from 'react';
import { useMarqueeStateStore } from '@/scene/marquee';
import { CURSOR_FOR_HANDLE, type HandleId, SCALE_HANDLES } from '../boxHandles';
import {
  moveRect,
  type Point,
  type Rect,
  rectCorners,
  rectHandlePositions,
  resizeRect,
} from './marqueeGeometry';

/**
 * Shared body for `RectMarquee.tsx` and `EllipseMarquee.tsx` — both are the
 * same drawn box (drag-to-move, 8 resize handles), only the outline shape
 * (`<polygon>` vs `<ellipse>`) differs. Keeping the drag logic in one place
 * means Rect and Ellipse can't drift apart the way three separately-hand-
 * rolled marquee components would (same risk the epic's shared-handle-module
 * acceptance calls out for TransformBox).
 *
 * Colours copied verbatim from `TransformBox.tsx` (roadmap: wrong as they
 * are, one colour-pass sweep later — not this story's job to invent new
 * ones).
 */

const HANDLE_SCREEN_RADIUS = 5;

/** Screen-space dash length for marquee outlines — shared with `LassoMarquee.tsx`. */
export const DASH_SCREEN_PX = 4;

type DragState =
  | { kind: 'move'; start: Rect; startPointerDoc: Point }
  | { kind: 'resize'; start: Rect; handle: HandleId };

export interface MarqueeBoxProps {
  kind: 'rect' | 'ellipse';
  rect: Rect;
  viewScale: number;
  /** Converts a pointer event's client coordinates to document space — shares the canvas's own view transform (same prop shape as `TransformBox`). */
  toDoc: (clientX: number, clientY: number) => Point;
}

export function MarqueeBox({ kind, rect, viewScale, toDoc }: MarqueeBoxProps) {
  const setMarquee = useMarqueeStateStore((s) => s.setMarquee);
  const dragRef = useRef<DragState | null>(null);
  const invScale = 1 / Math.max(viewScale, 0.0001);
  const radius = HANDLE_SCREEN_RADIUS * invScale;
  const strokeWidth = invScale;
  // Dashed outline distinguishes a selection marquee from TransformBox's
  // solid node bounds; dash length is screen-constant like the stroke width.
  const dash = `${DASH_SCREEN_PX * invScale} ${DASH_SCREEN_PX * invScale}`;

  function startDrag(e: React.PointerEvent, drag: DragState) {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = drag;

    const onMove = (ev: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const doc = toDoc(ev.clientX, ev.clientY);
      const next =
        current.kind === 'move'
          ? moveRect(current.start, {
              x: doc.x - current.startPointerDoc.x,
              y: doc.y - current.startPointerDoc.y,
            })
          : resizeRect(current.start, current.handle, doc, ev.shiftKey);
      setMarquee({ kind, rect: next });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const corners = rectCorners(rect);
  const handles = rectHandlePositions(rect);
  const outlinePoints = corners.map((p) => `${p.x},${p.y}`).join(' ');

  const startMove = (e: React.PointerEvent) =>
    startDrag(e, { kind: 'move', start: rect, startPointerDoc: toDoc(e.clientX, e.clientY) });

  return (
    <g data-testid={`${kind}-marquee`}>
      {kind === 'rect' ? (
        <polygon
          points={outlinePoints}
          fill="transparent"
          stroke="#38bdf8"
          strokeWidth={strokeWidth}
          strokeDasharray={dash}
          style={{ pointerEvents: 'auto', cursor: 'move' }}
          onPointerDown={startMove}
        />
      ) : (
        <ellipse
          cx={rect.x + rect.w / 2}
          cy={rect.y + rect.h / 2}
          rx={rect.w / 2}
          ry={rect.h / 2}
          fill="transparent"
          stroke="#38bdf8"
          strokeWidth={strokeWidth}
          strokeDasharray={dash}
          style={{ pointerEvents: 'auto', cursor: 'move' }}
          onPointerDown={startMove}
        />
      )}
      {SCALE_HANDLES.map((id) => (
        <circle
          key={id}
          data-handle={id}
          cx={handles[id].x}
          cy={handles[id].y}
          r={radius}
          fill="#38bdf8"
          stroke="#0c4a6e"
          strokeWidth={strokeWidth}
          style={{ cursor: CURSOR_FOR_HANDLE[id], pointerEvents: 'auto' }}
          onPointerDown={(e) => startDrag(e, { kind: 'resize', start: rect, handle: id })}
        />
      ))}
    </g>
  );
}
