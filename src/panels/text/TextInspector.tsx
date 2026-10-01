// Side-effecting import: the shared package's built-in renderers and Oblique's
// number/select/colour overrides (scrub-drag InputNumber, ToggleGroup) — the
// number fields below get their one-undo-step-per-scrub behaviour from there.
import '@/panels/stack/bootstrap';
import { PropertyPanel } from '@preset.nz/facets';
import { stackControlsDisabled } from '@/panels/stack/lockUi';
import type { TextNode } from '@/scene/types';
import { registerTextFieldRenderers } from './fontFieldRenderers';
import { registerTextScope, TEXT_SCOPE_KEY, type TextScopeContext } from './textScope';

// Module-level (idempotent), same rationale as stack/bootstrap.ts.
registerTextFieldRenderers();
registerTextScope();

/**
 * The Text section of the stack panel (text-tool-and-inspector.md): a facets
 * `PropertyPanel` on the `text-node` scope. A locked node renders it read-only,
 * the same treatment as `StackRow`. `selection` and `ctx` are fresh objects
 * every render on purpose — `PropertyPanel` memoises its values on them, and a
 * stable object would show stale values after an edit.
 */
export function TextInspector({ node }: { node: TextNode }) {
  const locked = stackControlsDisabled(node);
  const ctx: TextScopeContext = { font: node.font };
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40">
      <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Text
      </div>
      <PropertyPanel
        scopeKey={TEXT_SCOPE_KEY}
        selection={{ nodeId: node.id }}
        ctx={ctx}
        readOnly={locked}
      />
    </div>
  );
}
