import {
  isPixelMaskRef,
  isPixelNode,
  isTextNode,
  isVectorNode,
  type MaskRef,
  type Modifier,
  type ModifierDriver,
  type SceneNode,
} from '@/scene/types';

type GetRef = (maskId: string) => MaskRef | undefined;
type GetNode = (nodeId: string) => SceneNode | undefined;
/**
 * Identity of a driver layer's cooked raster as a cook would read it (cook.ts: the cache
 * level actually read and its write sequence). Optional: `restore.ts` compares scenes, where
 * only the scene-side inputs exist.
 */
export type DriverRasterKey = (driverId: string) => unknown;

/**
 * What a modifier's `maskId` resolves to, as cook inputs: the
 * mask ref plus the referenced node's live inputs. Shared by
 * `restore.ts` (an undo that only changes the referenced shape must dirty the
 * consumer), cook.ts's race guard (a mask-source edit landing mid-cook
 * must leave the consumer dirty) and the prefix descriptors, so all three read the same
 * definition of "the mask changed".
 *
 * The referenced shape's transform2d is a cook input too — document-pinned
 * masks rasterise at the shape's COMPOSITED position. A text target
 * (text-modifier-masks.md) is keyed by what shapes its glyph mask: the spec
 * fields + position. Fill/stroke are left out — the modifier mask is glyph
 * fill only, so they don't affect it.
 *
 * A pixel driver (layer-as-driver.md) is keyed by everything its cooked raster comes from:
 * its source, its own modifiers and THEIR masks (followed through other drivers, a cycle cut
 * where it closes), its lock state (a locked driver is read from its bake), and where it sits
 * (`transform2d`, `sourceSize`: it is sampled through them). `rasterKey`, when given, adds the
 * identity of the raster a cook would read, so a driver recook always reads as a change.
 */
export function resolvedMaskInput(
  maskId: string | undefined,
  getRef: GetRef,
  getNode: GetNode,
  rasterKey?: DriverRasterKey,
): unknown {
  return resolveIn(maskId, getRef, getNode, rasterKey, new Set());
}

/**
 * What a modifier's driver (Epic 27) resolves to, as cook inputs: its numbers plus everything
 * its layer's raster comes from, as for a pixel mask (`driverInputs`). Folded into the same
 * three places `resolvedMaskInput` is: the prefix descriptors, cook.ts's race guard and
 * `restore.ts`'s `cookAffectingChanged`. `null` for a modifier with no driver.
 */
export function resolvedDriverInput(
  driver: ModifierDriver | undefined,
  getRef: GetRef,
  getNode: GetNode,
  rasterKey?: DriverRasterKey,
): unknown {
  return resolveDriverIn(driver, getRef, getNode, rasterKey, new Set());
}

function resolveDriverIn(
  driver: ModifierDriver | undefined,
  getRef: GetRef,
  getNode: GetNode,
  rasterKey: DriverRasterKey | undefined,
  seen: Set<string>,
): unknown {
  if (!driver) return null;
  return {
    driver,
    layer: driverInputs(getNode(driver.nodeId), getRef, getNode, rasterKey, seen),
  };
}

function resolveIn(
  maskId: string | undefined,
  getRef: GetRef,
  getNode: GetNode,
  rasterKey: DriverRasterKey | undefined,
  seen: Set<string>,
): unknown {
  if (!maskId) return null;
  const ref = getRef(maskId);
  if (!ref) return null;
  const target = getNode(ref.nodeId);
  if (isPixelMaskRef(ref)) {
    return { ref, driver: driverInputs(target, getRef, getNode, rasterKey, seen) };
  }
  const geometry =
    target && isVectorNode(target)
      ? { paths: target.paths, fillRule: target.fillRule, transform2d: target.transform2d }
      : target && isTextNode(target)
        ? {
            text: {
              content: target.content,
              font: target.font,
              fontSize: target.fontSize,
              tracking: target.tracking,
              kerning: target.kerning,
              lineHeight: target.lineHeight,
              align: target.align,
              position: target.position,
            },
            transform2d: target.transform2d,
          }
        : null;
  return { ref, geometry };
}

function driverInputs(
  driver: SceneNode | undefined,
  getRef: GetRef,
  getNode: GetNode,
  rasterKey: DriverRasterKey | undefined,
  seen: Set<string>,
): unknown {
  if (!driver || !isPixelNode(driver)) return null;
  if (seen.has(driver.id)) return { cycle: driver.id };
  const inner = new Set(seen).add(driver.id);
  return {
    sourcePath: driver.sourcePath,
    sourceSize: driver.sourceSize,
    transform2d: driver.transform2d ?? null,
    state: driver.state,
    modifiers: driver.modifiers,
    masks: driver.modifiers.map((m) => resolveIn(m.maskId, getRef, getNode, rasterKey, inner)),
    // the driver's own drivers (Epic 27): its raster comes from them too
    drivers: driver.modifiers.map((m) =>
      resolveDriverIn(m.driver, getRef, getNode, rasterKey, inner),
    ),
    raster: rasterKey ? (rasterKey(driver.id) ?? null) : undefined,
  };
}

/**
 * Whether any of `modifiers` carries a resolvable DOCUMENT-pinned mask
 * (`space` absent or `'document'`, mask-follows-node.md; and every pixel driver, which is
 * always sampled where it sits on the page). Only such masks
 * rasterise through the consumer's CURRENT transform2d, so only they make the
 * consumer's transform a cook input — the one predicate behind
 * `setNodeTransform`'s dirty exception, cook.ts's race-guard key and
 * `restore.ts`'s `cookAffectingChanged`. A consumer whose masks are all
 * node-pinned goes back to "transform never recooks".
 */
export function hasDocumentPinnedMask(modifiers: Modifier[], getRef: GetRef): boolean {
  return modifiers.some((m) => {
    // a driver (Epic 27) is a pixel layer, always sampled where it sits on the page
    if (m.driver) return true;
    const ref = m.maskId ? getRef(m.maskId) : undefined;
    if (ref === undefined) return false;
    return isPixelMaskRef(ref) || ref.space !== 'node';
  });
}

// ---------------------------------------------------------------- the driver graph

/**
 * The pixel layers whose cooked raster `node`'s cook reads (layer-as-driver.md, Epic 27): one
 * per modifier masked by a pixel driver, and one per modifier a layer drives, in modifier
 * order, no repeats. Disabled modifiers count:
 * enabling one must not be able to close a cycle, and waiting on a driver a disabled modifier
 * names only costs order.
 */
export function pixelDriversOf(node: SceneNode, getRef: GetRef): string[] {
  const out: string[] = [];
  for (const m of node.modifiers) {
    const ref = m.maskId ? getRef(m.maskId) : undefined;
    if (isPixelMaskRef(ref) && !out.includes(ref.nodeId)) out.push(ref.nodeId);
    if (m.driver && !out.includes(m.driver.nodeId)) out.push(m.driver.nodeId);
  }
  return out;
}

/**
 * Whether `fromId`'s cook reads `targetId`'s cooked raster, directly or through other drivers.
 * A layer depends on itself only through a cycle.
 */
export function dependsOnLayer(
  fromId: string,
  targetId: string,
  getNode: GetNode,
  getRef: GetRef,
): boolean {
  const seen = new Set<string>();
  const stack = [fromId];
  while (stack.length > 0) {
    const node = getNode(stack.pop() as string);
    if (!node) continue;
    for (const driver of pixelDriversOf(node, getRef)) {
      if (driver === targetId) return true;
      if (!seen.has(driver)) {
        seen.add(driver);
        stack.push(driver);
      }
    }
  }
  return false;
}

/**
 * Why `driverId` can't drive a mask on one of `consumerId`'s modifiers, or `null` when it can
 * (layer-as-driver.md: "a layer can't drive a modifier whose output it depends on"). Rust's
 * `mask.attach_layer` refuses the same cases (`driver_refusal` in document/mod.rs); this copy is
 * what the panel shows beside the layer before anything is sent.
 */
export function driverRefusal(
  consumerId: string,
  driverId: string,
  getNode: GetNode,
  getRef: GetRef,
): string | null {
  const driver = getNode(driverId);
  if (!driver || !isPixelNode(driver)) return 'Only a pixel layer can drive a mask.';
  if (driverId === consumerId) return "A layer can't drive a mask on its own modifiers.";
  if (dependsOnLayer(driverId, consumerId, getNode, getRef)) {
    return `“${driver.label}” already takes a mask from this layer, so it can't drive one here.`;
  }
  return null;
}

/**
 * Why `driverId` can't be followed by one of `consumerId`'s modifiers (Epic 27), or `null` when
 * it can: the same cycle check as `driverRefusal`, worded for a driver. Rust's `driver.attach`
 * refuses the same cases (`follow_refusal` in document/mod.rs); this copy is what the panel
 * shows beside the layer before anything is sent.
 */
export function followRefusal(
  consumerId: string,
  driverId: string,
  getNode: GetNode,
  getRef: GetRef,
): string | null {
  const driver = getNode(driverId);
  if (!driver || !isPixelNode(driver)) return 'Only a pixel layer can drive a setting.';
  if (driverId === consumerId) return "A layer can't drive its own modifiers.";
  if (dependsOnLayer(driverId, consumerId, getNode, getRef)) {
    const consumer = getNode(consumerId);
    return `“${driver.label}” already takes its look from “${consumer?.label ?? ''}”, so “${consumer?.label ?? ''}” can't follow it.`;
  }
  return null;
}
