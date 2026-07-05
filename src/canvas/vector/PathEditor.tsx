import { useState } from 'react';
import { useSceneStore } from '@/scene/store';
import type { AnchorPoint, Point2D, VectorNode, VectorPath } from '@/scene/types';
import { IDENTITY_TRANSFORM_2D } from '@/scene/types';
import { pathCommandsFor } from '@/scene/vectorRasterize';
import { localToWorld, type NodeExtent, type Point, worldToLocal } from '../transform2d';
import {
  type AnchorMode,
  anchorMode,
  closestPointOnPaths,
  cycleAnchorMode,
  dragHandle,
  insertAnchorAt,
  moveAnchor,
} from './pathEdit';
import { usePathEditStateStore } from './pathEditState';
import { commandsToPathD } from './svgPath';
import { localDistanceThreshold, mapVectorPaths } from './vectorTransform';

/**
 * Direct-selection path editing overlay (features/06-vector-nodes/
 * path-editing.md). Mounted by `Viewport.tsx` in place of `TransformBox` for
 * a selected `VectorNode` under the move tool — the "honest v1" call the
 * story flags: a vector node's 8-handle scale/rotate box and its per-anchor
 * editing overlay would fight for the same click targets, so a selected
 * vector node gets THIS overlay instead, never both. Plain body drag-to-move
 * (`Viewport.tsx`'s own pointerdown hit-test, independent of TransformBox)
 * still works underneath — this component only claims the pixels near
 * anchors/handles/segments, never the filled interior.
 *
 * Every completed drag commits with exactly ONE `setVectorPaths` call on
 * pointerup (mirroring `usePenStateStore`'s "mutate only on commit" pattern,
 * not `TransformBox`'s per-pointermove mutation + transaction — the story is
 * explicit: "mutate ONLY on pointerup"). The live preview during a drag is
 * local component state (`liveNode`), never touching the scene store, so
 * Escape mid-drag discards it for free — no undo step, no recook, matching
 * `TransformBox`'s `dragRef` pattern for "what's dragging right now" but
 * using React state (not a ref) because the preview must re-render.
 *
 * `node.paths` are always stored in the node's own untransformed/local space
 * (same space `pathEdit.ts`'s geometry helpers operate in). Rendering maps
 * every point through `localToWorld` (`transform2d.ts`) so the overlay sits
 * on the painted (transformed) shape rather than its raw path coordinates
 * (bug fix, 2026-07-05) — points are mapped individually rather than
 * wrapping the SVG in a single `<g transform>` matrix, because a `<g>`
 * matrix would also scale stroke widths and anchor hit-radii non-uniformly
 * under a non-uniform or rotated `scaleX`/`scaleY` (turning circular anchors
 * into ellipses). Pointer input goes the other way: every doc-space point
 * from `toDoc` is mapped back to local space via `worldToLocal` before it's
 * compared against/written into `node.paths`.
 */

const ANCHOR_SCREEN_SIZE = 8; // corner square: full side length in screen px
const ANCHOR_SCREEN_RADIUS = 4; // smooth/symmetric circle radius in screen px
const HANDLE_SCREEN_RADIUS = 3;
/** Screen-space distance from pointer-down to "this became a drag, not a click". */
const CLICK_DRAG_SCREEN_PX = 3;
/** Screen-space distance within which a segment click inserts an anchor. */
const SEGMENT_CLICK_SCREEN_PX = 6;

export interface PathEditorProps {
  node: VectorNode;
  viewScale: number;
  /** Converts a pointer event's client coordinates to document space — shares the canvas's own view transform (same prop shape as `TransformBox`). */
  toDoc: (clientX: number, clientY: number) => Point;
  /** The node's raster extent for `transform2d` mapping — `scene.documentSize`, same convention as `composite.ts::destSizeFor`'s vector-node case (see `Viewport.tsx`). */
  extent: NodeExtent;
}

function updatePaths(
  paths: VectorPath[],
  pathIndex: number,
  fn: (path: VectorPath) => VectorPath,
): VectorPath[] {
  return paths.map((p, i) => (i === pathIndex ? fn(p) : p));
}

function updateAnchor(
  path: VectorPath,
  anchorIndex: number,
  fn: (anchor: AnchorPoint) => AnchorPoint,
): VectorPath {
  return { ...path, anchors: path.anchors.map((a, i) => (i === anchorIndex ? fn(a) : a)) };
}

export function PathEditor({ node, viewScale, toDoc, extent }: PathEditorProps) {
  const setVectorPaths = useSceneStore((s) => s.setVectorPaths);
  const activeAnchor = usePathEditStateStore((s) => s.activeAnchor);
  const setActiveAnchor = usePathEditStateStore((s) => s.setActiveAnchor);

  // Live preview during a drag — `null` when nothing is being dragged, in
  // which case the committed `node.paths` is what's drawn.
  const [dragPaths, setDragPaths] = useState<VectorPath[] | null>(null);
  const displayPaths = dragPaths ?? node.paths; // local/path space — source of truth for edits

  const transform2d = node.transform2d ?? IDENTITY_TRANSFORM_2D;
  const toWorld = (p: Point) => localToWorld(p, transform2d, extent);
  const toLocal = (p: Point) => worldToLocal(p, transform2d, extent);
  // World/doc-space paths — render-only; every edit still reads/writes `displayPaths`/`node.paths`.
  const worldPaths = mapVectorPaths(displayPaths, toWorld);

  const invScale = 1 / Math.max(viewScale, 0.0001);
  const strokeWidth = invScale;
  const anchorHalf = (ANCHOR_SCREEN_SIZE / 2) * invScale;
  const anchorRadius = ANCHOR_SCREEN_RADIUS * invScale;
  const handleRadius = HANDLE_SCREEN_RADIUS * invScale;
  const clickDragThresholdDoc = CLICK_DRAG_SCREEN_PX * invScale;
  const segmentClickThresholdDoc = SEGMENT_CLICK_SCREEN_PX * invScale;

  function onAnchorPointerDown(e: React.PointerEvent, pathIndex: number, anchorIndex: number) {
    e.stopPropagation();
    e.preventDefault();
    setActiveAnchor({ pathIndex, anchorIndex });

    const basePaths = node.paths;
    // The click-vs-drag threshold stays in doc/world space — it's a physical
    // pointer-movement gate, unrelated to the node's local path space.
    const startDoc = toDoc(e.clientX, e.clientY);
    const startLocal = toLocal(startDoc);
    let moved = false;
    let latest = basePaths;

    const onMove = (ev: PointerEvent) => {
      const doc = toDoc(ev.clientX, ev.clientY);
      const dx = doc.x - startDoc.x;
      const dy = doc.y - startDoc.y;
      if (!moved && dx * dx + dy * dy <= clickDragThresholdDoc * clickDragThresholdDoc) return;
      moved = true;
      // Anchors live in local/path space, so the applied delta must too —
      // computed by mapping both endpoints back through `worldToLocal`
      // rather than scaling the doc-space delta, so it's exact under
      // rotation as well as (non-uniform) scale.
      const local = toLocal(doc);
      const delta: Point2D = { x: local.x - startLocal.x, y: local.y - startLocal.y };
      latest = updatePaths(basePaths, pathIndex, (p) =>
        updateAnchor(p, anchorIndex, (a) => moveAnchor(a, delta)),
      );
      setDragPaths(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onEscape);
      setDragPaths(null);
      if (moved) {
        setVectorPaths(node.id, latest);
      } else {
        // Plain click (no drag): cycle corner -> smooth -> symmetric.
        const next = updatePaths(basePaths, pathIndex, (p) => cycleAnchorMode(p, anchorIndex));
        setVectorPaths(node.id, next);
      }
    };
    const onEscape = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onEscape);
      setDragPaths(null); // discard the in-flight drag, no commit
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onEscape);
  }

  function onHandlePointerDown(
    e: React.PointerEvent,
    pathIndex: number,
    anchorIndex: number,
    side: 'in' | 'out',
  ) {
    e.stopPropagation();
    e.preventDefault();
    setActiveAnchor({ pathIndex, anchorIndex });

    const basePaths = node.paths;
    // Mode is captured once, from the anchor's PRE-drag geometry — see
    // `pathEdit.ts::dragHandle`'s doc comment on why it must not be
    // re-derived mid-drag.
    const mode: AnchorMode = anchorMode(basePaths[pathIndex].anchors[anchorIndex]);
    let latest = basePaths;

    const onMove = (ev: PointerEvent) => {
      const doc = toDoc(ev.clientX, ev.clientY);
      const local = toLocal(doc);
      latest = updatePaths(basePaths, pathIndex, (p) =>
        updateAnchor(p, anchorIndex, (a) => dragHandle(a, side, local, mode)),
      );
      setDragPaths(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onEscape);
      setDragPaths(null);
      setVectorPaths(node.id, latest);
    };
    const onEscape = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onEscape);
      setDragPaths(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onEscape);
  }

  function onSegmentPointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    const doc = toDoc(e.clientX, e.clientY);
    const local = toLocal(doc);
    const hit = closestPointOnPaths(node.paths, local);
    const localThreshold = localDistanceThreshold(segmentClickThresholdDoc, transform2d);
    if (!hit || hit.distance > localThreshold) return;
    const next = insertAnchorAt(node.paths, hit);
    setVectorPaths(node.id, next);
  }

  return (
    <g data-testid="path-editor">
      {/* Wide, near-invisible hit stroke for segment-click-to-insert — sits
          only along the outline (fill="none"), so clicks inside the shape's
          filled interior fall through to the canvas's own move-drag
          hit-test underneath. */}
      <path
        d={commandsToPathD(pathCommandsFor(worldPaths))}
        fill="none"
        stroke="transparent"
        strokeWidth={SEGMENT_CLICK_SCREEN_PX * 2 * invScale}
        style={{ pointerEvents: 'auto', cursor: 'copy' }}
        onPointerDown={onSegmentPointerDown}
      />
      <path
        d={commandsToPathD(pathCommandsFor(worldPaths))}
        fill="none"
        stroke="#38bdf8"
        strokeWidth={strokeWidth}
        style={{ pointerEvents: 'none' }}
      />
      {displayPaths.map((path, pathIndex) =>
        path.anchors.map((localAnchor, anchorIndex) => {
          // Mode is derived from the LOCAL anchor (matches how `cycleAnchorMode`
          // etc. operate) — collinearity/mirror-ratio aren't invariant under a
          // non-uniform scale, so deriving it post-transform could disagree
          // with what an edit action actually does.
          const mode = anchorMode(localAnchor);
          const isSquare = mode === 'corner';
          const key = `${pathIndex}-${anchorIndex}`;
          // Rendered position comes from the WORLD-mapped anchor — same
          // index, transform2d-mapped point/handles.
          const anchor = worldPaths[pathIndex].anchors[anchorIndex];
          return (
            <g key={key}>
              {anchor.handleOut && (
                <line
                  x1={anchor.point.x}
                  y1={anchor.point.y}
                  x2={anchor.handleOut.x}
                  y2={anchor.handleOut.y}
                  stroke="#f472b6"
                  strokeWidth={strokeWidth}
                  style={{ pointerEvents: 'none' }}
                />
              )}
              {anchor.handleIn && (
                <line
                  x1={anchor.point.x}
                  y1={anchor.point.y}
                  x2={anchor.handleIn.x}
                  y2={anchor.handleIn.y}
                  stroke="#f472b6"
                  strokeWidth={strokeWidth}
                  style={{ pointerEvents: 'none' }}
                />
              )}
              {anchor.handleOut && (
                <circle
                  cx={anchor.handleOut.x}
                  cy={anchor.handleOut.y}
                  r={handleRadius}
                  fill="#f472b6"
                  stroke="#831843"
                  strokeWidth={strokeWidth}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onPointerDown={(e) => onHandlePointerDown(e, pathIndex, anchorIndex, 'out')}
                />
              )}
              {anchor.handleIn && (
                <circle
                  cx={anchor.handleIn.x}
                  cy={anchor.handleIn.y}
                  r={handleRadius}
                  fill="#f472b6"
                  stroke="#831843"
                  strokeWidth={strokeWidth}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onPointerDown={(e) => onHandlePointerDown(e, pathIndex, anchorIndex, 'in')}
                />
              )}
              {isSquare ? (
                <rect
                  data-testid="anchor-corner"
                  x={anchor.point.x - anchorHalf}
                  y={anchor.point.y - anchorHalf}
                  width={anchorHalf * 2}
                  height={anchorHalf * 2}
                  fill={
                    activeAnchor?.pathIndex === pathIndex &&
                    activeAnchor.anchorIndex === anchorIndex
                      ? '#f59e0b'
                      : '#38bdf8'
                  }
                  stroke="#0c4a6e"
                  strokeWidth={strokeWidth}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onPointerDown={(e) => onAnchorPointerDown(e, pathIndex, anchorIndex)}
                />
              ) : (
                <circle
                  data-testid="anchor-smooth"
                  cx={anchor.point.x}
                  cy={anchor.point.y}
                  r={anchorRadius}
                  fill={
                    activeAnchor?.pathIndex === pathIndex &&
                    activeAnchor.anchorIndex === anchorIndex
                      ? '#f59e0b'
                      : '#38bdf8'
                  }
                  stroke="#0c4a6e"
                  strokeWidth={strokeWidth}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onPointerDown={(e) => onAnchorPointerDown(e, pathIndex, anchorIndex)}
                />
              )}
            </g>
          );
        }),
      )}
    </g>
  );
}
