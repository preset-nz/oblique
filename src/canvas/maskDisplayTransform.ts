import { destSizeFor } from '@/compositor/composite';
import {
  IDENTITY_TRANSFORM_2D,
  type Scene,
  type Transform2D,
  type VectorMaskRef,
} from '@/scene/types';
import { localToWorld, type NodeExtent, type Point, worldToLocal } from './transform2d';

/**
 * Where a node-pinned mask is DRAWN and EDITED (features/05-selection/
 * mask-follows-node.md). A selection node's paths stay document-space as
 * authored; a node-pinned ref reads them through the consumer's attach-time
 * frame (`maskRasterize.ts` inverts `attachTransform`), and the consumer's
 * pixels have since been composited at its CURRENT transform. So the mask
 * visibly sits at `current ∘ inverse(attachTransform)` of the stored
 * geometry: this delta. `toDisplay` maps stored document-space points to the
 * document-space points where the mask really reads (overlay painting);
 * `fromDisplay` maps pointer positions back before anything is written, so
 * stored anchors stay document space — document space in, document space out.
 *
 * A pure function of `(ref, consumer)`, shared by the path-editing overlay
 * and the pen tool so the two can never disagree. Identity for
 * document-pinned refs.
 */
export interface MaskDisplayDelta {
  /** True when `toDisplay`/`fromDisplay` are the identity (document-pinned, or the consumer sits at its attach frame). */
  identity: boolean;
  /** Stored (document-space) point -> where the mask reads on the page. */
  toDisplay: (p: Point) => Point;
  /** Pointer (document-space) point -> stored geometry space. Inverse of `toDisplay`. */
  fromDisplay: (p: Point) => Point;
  /** Largest per-axis magnitude of the delta's scale — converts a document-space hit threshold to the stored-geometry space (same "max axis" call as `localDistanceThreshold`). */
  scale: number;
}

const IDENTITY_POINT_MAP = (p: Point): Point => p;

export const IDENTITY_MASK_DELTA: MaskDisplayDelta = {
  identity: true,
  toDisplay: IDENTITY_POINT_MAP,
  fromDisplay: IDENTITY_POINT_MAP,
  scale: 1,
};

/** The consumer's frame: its current transform (absent = identity) and its raster extent (`destSizeFor(…, 'baked', …)`). */
export interface MaskConsumerFrame {
  transform2d?: Transform2D;
  extent: NodeExtent;
}

function sameTransform(a: Transform2D, b: Transform2D): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.scaleX === b.scaleX &&
    a.scaleY === b.scaleY &&
    a.rotation === b.rotation
  );
}

function axisRatio(current: number, attach: number): number {
  return attach === 0 ? 1 : Math.abs(current / attach);
}

export function maskDisplayTransform(
  ref: Pick<VectorMaskRef, 'space' | 'attachTransform'>,
  consumer: MaskConsumerFrame,
): MaskDisplayDelta {
  if (ref.space !== 'node' || !ref.attachTransform) return IDENTITY_MASK_DELTA;
  const attach = ref.attachTransform;
  const current = consumer.transform2d ?? IDENTITY_TRANSFORM_2D;
  const { extent } = consumer;
  if (sameTransform(attach, current)) return IDENTITY_MASK_DELTA;
  return {
    identity: false,
    toDisplay: (p) => localToWorld(worldToLocal(p, attach, extent), current, extent),
    fromDisplay: (p) => localToWorld(worldToLocal(p, current, extent), attach, extent),
    scale: Math.max(
      axisRatio(current.scaleX, attach.scaleX),
      axisRatio(current.scaleY, attach.scaleY),
    ),
  };
}

/**
 * The ONE delta the path overlay and pen display and edit a vector node's
 * shape through. A shape can be referenced by several consumers; the
 * orchestrator's call (no per-consumer outlines) is the delta of the first
 * node-pinned ref (`Object.values(scene.maskRefs)` order) whose consumer
 * exists; identity when there is none.
 */
export function editingDeltaFor(vectorNodeId: string, scene: Scene): MaskDisplayDelta {
  for (const ref of Object.values(scene.maskRefs ?? {})) {
    if (ref.nodeId !== vectorNodeId || ref.space !== 'node' || !ref.attachTransform) continue;
    const consumer = scene.nodes.find((n) => n.modifiers.some((m) => m.maskId === ref.id));
    if (!consumer) continue;
    const [w, h] = destSizeFor(consumer, 'baked', scene.documentSize);
    return maskDisplayTransform(ref, { transform2d: consumer.transform2d, extent: { w, h } });
  }
  return IDENTITY_MASK_DELTA;
}
