import { IDENTITY_TRANSFORM_2D, type Transform2D } from './types';

/**
 * Pure maths for replacing a pixel node's source (image-source.md, decisions
 * 5 and 6). A node draws its `sourceSize` box with `(x, y)` as the translation,
 * then scales and rotates about the box's own centre (`compositor/composite.ts`
 * `withNodeTransform`), so its document-space centre is `(x + w/2, y + h/2)`
 * whatever the scale or rotation, and its footprint is `w·|sx|` by `h·|sy|`.
 */

type Size = readonly [number, number];

/** `-1` for a negative scale, else `1` (a zero scale reads as unflipped). */
function signOf(n: number): number {
  return n < 0 ? -1 : 1;
}

/**
 * The transform that makes a new source of `newSize` fit uniformly inside the
 * old footprint, centred on the old centre. Rotation and flip signs survive.
 * A collapsed old footprint (a zero scale) has no box to fit: the scale is kept
 * and only the centre is preserved.
 */
export function fitReplacedTransform(
  old: Transform2D | undefined,
  oldSize: Size,
  newSize: Size,
): Transform2D {
  const t = old ?? IDENTITY_TRANSFORM_2D;
  const [w0, h0] = oldSize;
  const [w1, h1] = newSize;
  const footprintW = w0 * Math.abs(t.scaleX);
  const footprintH = h0 * Math.abs(t.scaleY);
  const fits = footprintW > 0 && footprintH > 0 && w1 > 0 && h1 > 0;
  const s = fits ? Math.min(footprintW / w1, footprintH / h1) : null;
  return {
    x: t.x + w0 / 2 - w1 / 2,
    y: t.y + h0 / 2 - h1 / 2,
    scaleX: s === null ? t.scaleX : s * signOf(t.scaleX),
    scaleY: s === null ? t.scaleY : s * signOf(t.scaleY),
    rotation: t.rotation,
  };
}

/**
 * A `space: 'node'` mask's `attachTransform` after its consumer's source was
 * replaced. The rasteriser maps document -> mask-buffer through
 * `docToLocalMatrix(attachTransform, sourceSize)`, which pairs the snapshot
 * with the CURRENT `sourceSize`, so changing `sourceSize` alone (or with only
 * the node's own transform) would shift and rescale the mask. Solving
 * `localToDoc(newNode, newSize) ∘ docToLocal(newAttach, newSize) =
 * localToDoc(oldNode, oldSize) ∘ docToLocal(oldAttach, oldSize)` for
 * `newAttach` (the replace keeps the node's centre and rotation) gives: keep
 * the snapshot's rotation and centre, and scale each axis by the node's own
 * scale ratio. The mask then covers the same canvas region it did before.
 */
export function refitAttachTransform(
  attach: Transform2D,
  oldNode: Transform2D | undefined,
  newNode: Transform2D,
  oldSize: Size,
  newSize: Size,
): Transform2D {
  const old = oldNode ?? IDENTITY_TRANSFORM_2D;
  const ratioX = old.scaleX === 0 ? 1 : newNode.scaleX / old.scaleX;
  const ratioY = old.scaleY === 0 ? 1 : newNode.scaleY / old.scaleY;
  return {
    x: attach.x + oldSize[0] / 2 - newSize[0] / 2,
    y: attach.y + oldSize[1] / 2 - newSize[1] / 2,
    scaleX: attach.scaleX * ratioX,
    scaleY: attach.scaleY * ratioY,
    rotation: attach.rotation,
  };
}
