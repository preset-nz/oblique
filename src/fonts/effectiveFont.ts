import type { TextNode } from '@/scene/types';
import type { FontRef } from './types';

/**
 * The font a text node is actually shaped with. Today that is simply the wanted
 * font; missing-fonts.md (Epic 20 story 6) swaps this body for the substitution
 * lookup. EVERY path that turns a text node into a `TextSpec` goes through here.
 */
export function effectiveFontFor(node: TextNode): FontRef {
  return node.font;
}
