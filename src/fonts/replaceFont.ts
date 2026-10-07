import { useSceneStore } from '@/scene/store';
import { beginTransaction, endTransaction } from '@/scene/transaction';
import { isTextNode } from '@/scene/types';
import type { FontRef } from './types';

/** One Replace Font row: every text node wanting `fromPostscript` gets `to`. */
export interface FontReplacement {
  fromPostscript: string;
  to: FontRef;
}

/**
 * Applies the replacements to the live scene as ONE undo step. Locked nodes are
 * skipped (and counted), because `setTextProps` refuses them. Replacements that
 * map a font to itself are ignored.
 */
export function applyFontReplacements(replacements: readonly FontReplacement[]): {
  replaced: number;
  skipped: number;
} {
  const wanted = new Map(
    replacements
      .filter((r) => r.fromPostscript !== r.to.postscriptName)
      .map((r) => [r.fromPostscript, r.to]),
  );
  let replaced = 0;
  let skipped = 0;
  if (wanted.size === 0) return { replaced, skipped };

  beginTransaction();
  try {
    for (const node of useSceneStore.getState().scene.nodes) {
      if (!isTextNode(node)) continue;
      const to = wanted.get(node.font.postscriptName);
      if (!to) continue;
      if (node.state === 'locked') {
        skipped++;
        continue;
      }
      useSceneStore.getState().setTextProps(node.id, { font: to });
      replaced++;
    }
  } finally {
    endTransaction();
  }
  return { replaced, skipped };
}
