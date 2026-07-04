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
  maskId?: string; // Epic 05+; present in the type now
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
}
