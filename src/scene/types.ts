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

export interface SceneNode {
  id: string;
  label: string;
  type: NodeType;
  state: NodeState;
  output: NodeOutput;
  transform?: number[]; // mat4, 3D nodes only (Milestone B)
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
