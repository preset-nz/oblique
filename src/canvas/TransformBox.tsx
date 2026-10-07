import { useRef } from 'react';
import { useSceneStore } from '@/scene/store';
import { beginTransaction, endTransaction } from '@/scene/transaction';
import { IDENTITY_TRANSFORM_2D, type SceneNode, type Transform2D } from '@/scene/types';
import { CURSOR_FOR_HANDLE, SCALE_HANDLES } from './boxHandles';
import {
  applyRotate,
  applyScale,
  boundsCorners,
  type HandleId,
  handlePositions,
  type Point,
} from './transform2d';

/**
 * The node-transform-2d overlay (features/05-selection/node-transform-2d.md):
 * 8 scale handles + a rotation handle above top-centre, rendered on the
 * shared document-space SVG overlay (`Viewport.tsx`). Mutates `transform2d`
 * only via `useSceneStore`'s `setNodeTransform` action (depcruise/epic
 * acceptance: "TransformBox... mutates via a store action only").
 *
 * Move (dragging the node's body) is handled by `Viewport.tsx`'s own canvas
 * pointer handler, not here — this component only owns the handles.
 * `Viewport.tsx` renders this component only under the move tool
 * (tool-state.md); this file itself doesn't know about tools at all — it's
 * always "live" whenever mounted, same as when it was written before
 * tool-state.md landed (`marquees.md` added the `tool === 'move'` gate at
 * the call site so a marquee tool's own handles don't overlap these).
 */

const HANDLE_SCREEN_RADIUS = 5;

type DragState =
  | { kind: 'rotate'; start: Transform2D; startPointerDoc: Point }
  | { kind: 'scale'; start: Transform2D; handle: Exclude<HandleId, 'rotate'> };

export interface TransformBoxProps {
  node: SceneNode;
  extent: { w: number; h: number };
  viewScale: number;
  /** Converts a pointer event's client coordinates to document space — shares the canvas's own view transform. */
  toDoc: (clientX: number, clientY: number) => Point;
}

export function TransformBox({ node, extent, viewScale, toDoc }: TransformBoxProps) {
  const setNodeTransform = useSceneStore((s) => s.setNodeTransform);
  const dragRef = useRef<DragState | null>(null);

  const t = node.transform2d ?? IDENTITY_TRANSFORM_2D;
  const corners = boundsCorners(t, extent);
  const handles = handlePositions(t, extent);
  // Constant screen-space size regardless of zoom.
  const radius = HANDLE_SCREEN_RADIUS / Math.max(viewScale, 0.0001);

  function startDrag(e: React.PointerEvent, drag: DragState) {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = drag;
    beginTransaction();

    const onMove = (ev: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const doc = toDoc(ev.clientX, ev.clientY);
      const snap = ev.shiftKey;
      const next =
        current.kind === 'rotate'
          ? applyRotate(current.start, extent, doc, current.startPointerDoc, snap)
          : applyScale(current.start, extent, current.handle, doc, snap);
      setNodeTransform(node.id, next);
    };
    const onUp = () => {
      dragRef.current = null;
      endTransaction();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const outlinePoints = corners.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <g data-testid="transform-box">
      <polygon
        points={outlinePoints}
        fill="none"
        stroke="#38bdf8"
        strokeWidth={1 / Math.max(viewScale, 0.0001)}
        style={{ pointerEvents: 'none' }}
      />
      <line
        x1={handles.n.x}
        y1={handles.n.y}
        x2={handles.rotate.x}
        y2={handles.rotate.y}
        stroke="#38bdf8"
        strokeWidth={1 / Math.max(viewScale, 0.0001)}
        style={{ pointerEvents: 'none' }}
      />
      {SCALE_HANDLES.map((id) => (
        <circle
          key={id}
          data-handle={id}
          cx={handles[id].x}
          cy={handles[id].y}
          r={radius}
          fill="#38bdf8"
          stroke="#0c4a6e"
          strokeWidth={1 / Math.max(viewScale, 0.0001)}
          style={{ cursor: CURSOR_FOR_HANDLE[id], pointerEvents: 'auto' }}
          onPointerDown={(e) => startDrag(e, { kind: 'scale', start: t, handle: id })}
        />
      ))}
      <circle
        data-handle="rotate"
        cx={handles.rotate.x}
        cy={handles.rotate.y}
        r={radius}
        fill="#f59e0b"
        stroke="#78350f"
        strokeWidth={1 / Math.max(viewScale, 0.0001)}
        style={{ cursor: 'grab', pointerEvents: 'auto' }}
        onPointerDown={(e) =>
          startDrag(e, {
            kind: 'rotate',
            start: t,
            startPointerDoc: toDoc(e.clientX, e.clientY),
          })
        }
      />
    </g>
  );
}
