import { getGeometry, useTextGeometryStore } from '@/scene/textGeometryCache';
import type { TextNode } from '@/scene/types';
import { boundsCornersDoc } from './textFrame';

/** Same outline colour as `TransformBox`. */
const OUTLINE = '#38bdf8';

export interface TextBoundsProps {
  node: TextNode;
  viewScale: number;
  documentSize: readonly [number, number];
}

/**
 * A thin document-space outline of the selected text node's glyph bounds
 * (text-tool-and-inspector.md), drawn on the shared SVG overlay in place of
 * `TransformBox` — that box would frame the whole document-sized raster.
 * Corners go through the node's `transform2d` (the same `localToWorld`
 * `PathEditor` uses), so the outline follows a Move-tool drag. Not interactive.
 */
export function TextBounds({ node, viewScale, documentSize }: TextBoundsProps) {
  useTextGeometryStore((s) => s.version); // re-render when geometry lands
  const corners = boundsCornersDoc(node, getGeometry(node), documentSize);
  if (corners.length === 0) return null;
  return (
    <polygon
      points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
      fill="none"
      stroke={OUTLINE}
      strokeWidth={1 / Math.max(viewScale, 0.0001)}
      pointerEvents="none"
    />
  );
}
