// Side-effecting import: the shared package's built-in renderers and Oblique's
// number/select/colour overrides (scrub-drag InputNumber, ToggleGroup) — the
// number fields below get their one-undo-step-per-scrub behaviour from there.
import '@/panels/stack/bootstrap';
import { PropertyPanel } from '@preset.nz/facets';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { missingFontTooltip, useMissingFont } from '@/fonts/missingFonts';
import { stackControlsDisabled } from '@/panels/stack/lockUi';
import type { TextNode } from '@/scene/types';
import { registerTextFieldRenderers } from './fontFieldRenderers';
import { registerTextScope, TEXT_SCOPE_KEY, type TextScopeContext } from './textScope';
import { useTextSectionStore } from './textSectionCollapse';

// Module-level (idempotent), same rationale as stack/bootstrap.ts.
registerTextFieldRenderers();
registerTextScope();

/**
 * The Text section of the stack panel (text-tool-and-inspector.md): a facets
 * `PropertyPanel` on the `text-node` scope. A locked node renders it read-only,
 * the same treatment as `StackRow`. The header row folds the fields away
 * (`textSectionCollapse.ts`). `selection` and `ctx` are fresh objects
 * every render on purpose — `PropertyPanel` memoises its values on them, and a
 * stable object would show stale values after an edit.
 */
export function TextInspector({ node }: { node: TextNode }) {
  const locked = stackControlsDisabled(node);
  const missing = useMissingFont(node.font);
  const collapsed = useTextSectionStore((s) => s.collapsed);
  const toggle = useTextSectionStore((s) => s.toggle);
  const ctx: TextScopeContext = {
    nodeId: node.id,
    font: node.font,
    missingHint: missing ? missingFontTooltip(node.font, missing.substitute) : undefined,
  };
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand Text' : 'Collapse Text'}
        className="flex w-full items-center gap-1 px-3 pt-2 pb-1 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-neutral-200"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        Text
      </button>
      {!collapsed && (
        <PropertyPanel
          // A new node remounts the fields: the Text field's focus belongs to one node.
          key={node.id}
          scopeKey={TEXT_SCOPE_KEY}
          selection={{ nodeId: node.id }}
          ctx={ctx}
          readOnly={locked}
        />
      )}
    </div>
  );
}
