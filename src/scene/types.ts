export type Resolution = 'draft' | 'working' | 'baked';
export type NodeType = 'pixel' | 'vector' | 'mesh' | 'splat';
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
  maskId?: string; // references Scene.masks (selection-to-mask.md); per-MODIFIER scope, deliberately not per-node
}

/**
 * The geometry a mask rasterises from (selection-to-mask.md) — the marquee's
 * shape as drawn, document-space coordinates. Stored as a path, never a
 * baked bitmap: the bitmap is derived at cook time (maskRasterize.ts) and
 * rebuilt like any cache. A lasso is always closed here (an open lasso
 * can't become a mask).
 */
export type MaskShape =
  | { kind: 'rect'; rect: { x: number; y: number; w: number; h: number } }
  | { kind: 'ellipse'; rect: { x: number; y: number; w: number; h: number } }
  | { kind: 'lasso'; points: { x: number; y: number }[] };

/**
 * One modifier mask (selection-to-mask.md). `shape` stays in document space
 * exactly as the marquee was drawn; `appliedTransform2d` snapshots the
 * node's transform at apply time so rasterisation can map document → node-
 * local pixels once, forever. The snapshot — not the live transform — is
 * what keeps the epic acceptance true: moving a masked node later never
 * re-rasterises or recooks (the mask rides along, glued to the node pixels
 * it was applied to). `featherPx`/`expand` are document-space px (spatial
 * params — the rasteriser scales them by the cook resolution factor, same
 * convention as gaussian_blur.radius).
 */
export interface MaskDef {
  id: string;
  shape: MaskShape;
  appliedTransform2d: Transform2D;
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

// Epic 08 will replace this with the real Camera type from the source spec;
// `never` keeps `cameras` strictly empty (and tsc-clean) until then.
export type Camera = never;

export interface Scene {
  id: string;
  nodes: SceneNode[]; // index 0 = TOP of stack (layer-panel order)
  cameras: Camera[]; // typed properly in Epic 08; empty array until then
  defaultCameraId: string | null;
  resolution: Resolution; // current global cook target ('working' default)
  documentSize: [number, number];
  /**
   * Modifier masks by id (selection-to-mask.md), referenced from
   * `Modifier.maskId`. Optional so pre-mask `.oblique` files load verbatim —
   * treat absence as empty. 1:1 with modifiers today (see the story's open
   * question); entries are pruned when their modifier/node goes.
   */
  masks?: Record<string, MaskDef>;
}
