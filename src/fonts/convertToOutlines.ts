import { toast } from 'sonner';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { documentPathsFor, ensureGeometry, specFor, specKey } from '@/scene/textGeometryCache';
import { isTextNode, type TextNode } from '@/scene/types';

/**
 * Type → Convert to Outlines (convert-to-outlines.md). The live render already
 * is glyph `VectorPath[]` (the geometry cache), so conversion copies it: what
 * you saw is what you get, by construction.
 */

const WHITE = new Set(['#fff', '#ffffff', '#ffffffff']);

/** The confirmation toast: the colour caveat shows only when there was colour to lose. */
export function convertedToastMessage(node: TextNode): string {
  const nonWhiteFill = node.fill !== null && !WHITE.has(node.fill.trim().toLowerCase());
  return nonWhiteFill || node.stroke !== null
    ? "Converted to outlines — fill colour and stroke aren't carried (vector layers are coloured by modifiers)"
    : 'Converted to outlines';
}

function selectedTextNode(): TextNode | null {
  const selection = useSelectionStore.getState().selection;
  if (selection.kind !== 'node') return null;
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === selection.nodeId);
  return node && isTextNode(node) && node.state !== 'locked' ? node : null;
}

/** Converts the selected, unlocked text layer to a vector layer in place. */
export async function convertSelectedTextToOutlines(): Promise<void> {
  let node = selectedTextNode();
  if (!node) {
    toast('Select an unlocked text layer to convert');
    return;
  }

  try {
    // The node can change while Rust shapes it (the geometry is keyed by spec),
    // so re-read afterwards and only convert geometry that matches what's there now.
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = specKey(specFor(node));
      const geometry = await ensureGeometry(node);
      const fresh = selectedTextNode();
      if (!fresh || fresh.id !== node.id) {
        toast('Select an unlocked text layer to convert');
        return;
      }
      node = fresh;
      if (specKey(specFor(node)) !== key) continue;

      const newId = useSceneStore
        .getState()
        .convertTextToOutlines(node.id, documentPathsFor(node, geometry));
      if (!newId) {
        toast('Select an unlocked text layer to convert');
        return;
      }
      useSelectionStore.getState().selectNode(newId);
      toast(convertedToastMessage(node));
      return;
    }
    toast.error('The text kept changing, so it was not converted. Try again.');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}
