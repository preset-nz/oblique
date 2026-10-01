import type { FontRef } from '@/fonts/types';

export type Resolution = 'draft' | 'working' | 'baked';
export type NodeType = 'pixel' | 'vector' | 'text' | 'mesh' | 'splat';
export type NodeState = 'active' | 'locked';
export type NodeOutput = 'image' | 'mask' | 'transform' | 'data';
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'difference';

export interface Modifier {
  id: string;
  type: string; // op name from sidecar list_ops
  enabled: boolean;
  params: Record<string, number | string | boolean>;
  maskId?: string; // resolves against Scene.maskRefs (vector-modifier-masks.md); per-MODIFIER scope, deliberately not per-node
}

/**
 * A modifier mask that stays *live* against a VectorNode's current paths
 * (vector-modifier-masks.md) — the epic's "editable forever" half.
 *
 * `featherPx`/`expand`/`invert` live HERE, not on the `VectorNode` — the
 * story's explicit call: the reference decides how soft/expanded/inverted
 * the mask reads, the node just supplies geometry. That is also what makes
 * reuse free: many `VectorMaskRef` entries (one per modifier that wants its
 * own feather/invert) can point at the same `nodeId`.
 *
 * Vector masks are DOCUMENT-PINNED (Georg's call, 2026-07-06 dogfood): the
 * mask reads where the shape sits in the document, always. The rasteriser
 * maps document space into the consumer's local buffer through the
 * consumer's CURRENT transform2d
 * at cook time (cook.ts passes it), so moving the consumer re-rasterises
 * the mask in its new frame — a deliberate, narrow exception to the
 * "transform2d never recooks" rule (dirty rule 4), scoped to nodes whose
 * modifiers carry a vector mask (`store.ts`'s `setNodeTransform`). If
 * attach-time transforms on the reference itself are ever wanted
 * (node-graph territory), that's a new field and a new story — not
 * snapshot semantics by the back door.
 */
export interface VectorMaskRef {
  id: string;
  nodeId: string; // a VectorNode's id
  featherPx: number;
  expand: number;
  invert: boolean;
}

/**
 * Uniform 2D node transform (Epic 05, node-transform-2d.md, locked
 * 2026-07-04) — move/scale/rotate, identical across every node type.
 * Applied by the compositor at draw time only: compositing-only, never
 * dirties, never recooks (dirty rule 4 extends to it). `x`/`y` are
 * document-space (full/BAKED resolution) pixels — a translation added on
 * top of the node's default draw-at-origin position, not an absolute
 * canvas position. `rotation` is radians, applied around the node's own
 * centre. Distinct from the 3D `transform: mat4` field below (camera/world
 * space, Milestone B) — different field, no interaction between them.
 */
export interface Transform2D {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number; // radians
}

export const IDENTITY_TRANSFORM_2D: Transform2D = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
};

export interface SceneNode {
  id: string;
  label: string;
  type: NodeType;
  state: NodeState;
  output: NodeOutput;
  transform?: number[]; // mat4, 3D nodes only (Milestone B)
  transform2d?: Transform2D; // optional, identity when absent — see Transform2D above
  cameraId?: string | null;
  modifiers: Modifier[];
  visible: boolean;
  blendMode: BlendMode;
  opacity: number; // 0-1
  dirty: { draft: boolean; working: boolean };
  // NOTE: caches are NOT here — see cache.ts. Scene stays JSON-serialisable.
}

export interface PixelNode extends SceneNode {
  type: 'pixel';
  sourcePath: string; // absolute path; bytes re-decoded on load
  sourceSize: [number, number]; // document-space dimensions
}

export function isPixelNode(node: SceneNode): node is PixelNode {
  return node.type === 'pixel';
}

/**
 * A single document-space `{x, y}` control point — anchors, tangent handles,
 * and lasso points all share this shape.
 */
export interface Point2D {
  x: number;
  y: number;
}

/**
 * One point on a `VectorPath` (vector-node-model.md). `point` is the anchor
 * itself; `handleIn`/`handleOut` are the incoming/outgoing cubic Bezier
 * control points, document-space absolute coordinates (not deltas) — absence
 * of a handle means that side is a corner (straight segment, no curvature).
 * A symmetric/smooth anchor is just both handles present and consistent;
 * this story stores geometry only, no smoothing metadata (path-editing.md's
 * job).
 */
export interface AnchorPoint {
  point: Point2D;
  handleIn?: Point2D;
  handleOut?: Point2D;
}

/**
 * An ordered list of anchors forming one contour. `closed` connects the
 * last anchor back to the first (using the last anchor's `handleOut` and
 * the first anchor's `handleIn`, same as any other segment) — an open path
 * never gets a closing segment.
 */
export interface VectorPath {
  anchors: AnchorPoint[];
  closed: boolean;
}

/**
 * A vector shape node (vector-node-model.md): `paths` rasterise to the
 * node's *source pixels* at cook time (vectorRasterize.ts) — same role a
 * decoded file plays for `PixelNode`. No `sourcePath`/`sourceSize`: the
 * raster always spans `Scene.documentSize` at the cook target's resolution
 * factor (cheap and correct for masks; bounding-box tightness is a later
 * concern if memory ever hurts). `fillRule` matches the Canvas 2D `Path2D`
 * fill rule of the same name.
 */
export interface VectorNode extends SceneNode {
  type: 'vector';
  paths: VectorPath[];
  fillRule: 'nonzero' | 'evenodd';
}

export function isVectorNode(node: SceneNode): node is VectorNode {
  return node.type === 'vector';
}

/**
 * A live text node (Epic 20, text-node-model.md). Like a vector node its raster
 * spans `Scene.documentSize`; the glyph geometry is shaped in Rust (anchor space)
 * and cached outside the scene (textGeometryCache.ts). `font` is the WANTED font,
 * never rewritten by substitution. `position` is the first line's alphabetic
 * baseline at the align anchor, in document space.
 */
export interface TextNode extends SceneNode {
  type: 'text';
  content: string; // '\n' = line break; no wrapping
  font: FontRef;
  fontSize: number; // document px (em size)
  tracking: number; // 1/1000 em, added after every glyph cluster
  kerning: boolean; // font kern pairs; default true
  lineHeight: number; // multiple of fontSize (default 1.2)
  align: 'left' | 'center' | 'right';
  fill: string | null; // CSS hex; null = no fill
  stroke: { color: string; width: number } | null; // width in document px, centred on the outline
  position: Point2D;
}

export function isTextNode(node: SceneNode): node is TextNode {
  return node.type === 'text';
}

// Epic 08 will replace this with the real Camera type from the source spec;
// `never` keeps `cameras` strictly empty (and tsc-clean) until then.
export type Camera = never;

/**
 * Document-level background ("paper" — background-colour.md), always the
 * lowest thing in the composite: painted before the node walk starts, so it
 * can't be masked, reordered, blend-moded, or deleted like a node could.
 * Discriminated union so a follow-on story (background-image.md) can add an
 * `{ type: 'image'; ... }` member without touching this one. `color` is a
 * CSS hex string, solid colour only for this story — no gradient/pattern.
 */
export type SceneBackground = { type: 'color'; color: string };

export interface Scene {
  id: string;
  nodes: SceneNode[]; // index 0 = TOP of stack (layer-panel order)
  cameras: Camera[]; // typed properly in Epic 08; empty array until then
  defaultCameraId: string | null;
  resolution: Resolution; // current global cook target ('working' default)
  documentSize: [number, number];
  /**
   * Live vector-referenced modifier masks (vector-modifier-masks.md),
   * what `Modifier.maskId` resolves against. Optional so pre-Epic-06
   * `.oblique` files load verbatim — treat absence as empty. Entries are
   * pruned when their modifier, node, or referenced vector node goes (see
   * `store.ts`'s `pruneMaskState`).
   */
  maskRefs?: Record<string, VectorMaskRef>;
  /**
   * Document background (background-colour.md). Optional so pre-existing
   * `.oblique` files load verbatim — absence means today's behaviour
   * (transparent, whatever the bottom node paints). Not a node: no z-order,
   * no blend mode, no lock state, no visibility toggle beyond set/none.
   */
  background?: SceneBackground;
}
