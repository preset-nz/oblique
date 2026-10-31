import { useActiveSelectionStore } from '@/scene/activeSelection';
import { useMarqueeStateStore } from '@/scene/marquee';
import { useSceneStore } from '@/scene/store';
import { IDENTITY_TRANSFORM_2D, isSelectionNode, type Scene, type VectorNode } from '@/scene/types';
import { pathCommandsFor } from '@/scene/vectorRasterize';
import { DASH_SCREEN_PX } from './marquees/MarqueeBox';
import { editingDeltaFor } from './maskDisplayTransform';
import { SelectionFill } from './SelectionFill';
import { commandsToPathD } from './vector/svgPath';
import { mapVectorPaths, vectorPointMaps } from './vector/vectorTransform';

/**
 * The active selection on the canvas (selections-panel.md): the saved selection's paths as the
 * marquees' dashed sky-blue outline with the plain tint under it, in every tool. Rendered in
 * `Viewport.tsx`'s overlay `<g>` (document space) beside the marquees; a live marquee hides it,
 * because a new selection is being made.
 *
 * The tint is the raw shape (`params` left off): feather, expand and invert live on mask
 * references, not on the shape. Everything is `pointer-events: none` so it never catches a click
 * meant for the tool underneath.
 */

/**
 * The selection's paths as one SVG `d` in document space, drawn where the shape shows on the
 * page: through the node's own transform and the node-pinned-mask display delta, the same two
 * maps `PathEditor` draws its anchors through, so after Edit Shape the outline and the anchors
 * agree. Every sub-path goes in one `d` so `evenodd` can cut holes.
 */
export function activeSelectionPathData(node: VectorNode, scene: Scene): string {
  const { toWorld } = vectorPointMaps(
    node.transform2d ?? IDENTITY_TRANSFORM_2D,
    { w: scene.documentSize[0], h: scene.documentSize[1] },
    editingDeltaFor(node.id, scene),
  );
  return commandsToPathD(pathCommandsFor(mapVectorPaths(node.paths, toWorld)));
}

export function ActiveSelectionOverlay({ viewScale }: { viewScale: number }) {
  const activeId = useActiveSelectionStore((s) => s.id);
  const hasMarquee = useMarqueeStateStore((s) => s.marquee !== null);
  const scene = useSceneStore((s) => s.scene);
  if (!activeId || hasMarquee) return null;
  const node = scene.nodes.find((n) => n.id === activeId);
  if (!node || !isSelectionNode(node)) return null;

  const d = activeSelectionPathData(node, scene);
  if (d === '') return null;
  const strokeWidth = 1 / Math.max(viewScale, 0.0001);
  const dash = `${DASH_SCREEN_PX * strokeWidth} ${DASH_SCREEN_PX * strokeWidth}`;

  return (
    <g data-testid="active-selection" style={{ pointerEvents: 'none' }}>
      <SelectionFill d={d} fillRule={node.fillRule} />
      <path
        d={d}
        fill="none"
        fillRule={node.fillRule}
        stroke="#38bdf8"
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        style={{ pointerEvents: 'none' }}
      />
    </g>
  );
}
