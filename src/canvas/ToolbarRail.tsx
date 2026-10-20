import { ModelDeclined, useModelGate } from '@preset.nz/app-kit/models';
import { Icons } from '@preset.nz/ux-kit';
import { MOBILE_SAM_ID } from '@/ai/sidecarSegment';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidecarStatusStore } from '@/sidecar/client';
import { type Tool, useToolStateStore } from './toolState';

interface ToolButtonSpec {
  tool: Tool;
  label: string;
  icon: Icons.Icon;
  disabled?: boolean;
  /**
   * Gated on live sidecar connectivity, not on any static `disabled` flag
   * (Epic 17 acceptance: "every AI affordance is disabled with an honest
   * hint" — and colour-range-select.md's own "never disabled by weights —
   * only by sidecar down", since it needs no model at all). `disabledHint`
   * replaces `label` in the tooltip/aria-label while gated off.
   */
  sidecarGated?: boolean;
  disabledHint?: string;
}

const TOOLS: ToolButtonSpec[] = [
  { tool: 'pan', label: 'Pan', icon: Icons.HandIcon },
  { tool: 'move', label: 'Move (V)', icon: Icons.ArrowsOutCardinalIcon },
  { tool: 'select-rect', label: 'Rectangle select (M)', icon: Icons.SquareIcon },
  { tool: 'select-ellipse', label: 'Ellipse select', icon: Icons.CircleIcon },
  { tool: 'select-lasso', label: 'Lasso select', icon: Icons.LassoIcon },
  {
    tool: 'select-smart',
    label: 'Smart select — click an object; Alt-click to exclude; drag a box',
    icon: Icons.MagicWandIcon,
    sidecarGated: true,
    disabledHint: 'Smart select — Sidecar not running',
  },
  {
    tool: 'select-colour',
    label: 'Colour select — click a colour; Alt-click to exclude; Shift-click adds',
    icon: Icons.EyedropperIcon,
    sidecarGated: true,
    disabledHint: 'Colour select — Sidecar not running',
  },
  { tool: 'pen', label: 'Pen', icon: Icons.PenNibIcon },
  { tool: 'text', label: 'Text (T)', icon: Icons.TextTIcon },
];

/** The model a tool needs before it arms, and the name the prompt shows for it (model-downloads.md). */
const TOOL_MODELS: Partial<Record<Tool, { id: string; for: string }>> = {
  'select-smart': { id: MOBILE_SAM_ID, for: 'Smart Select' },
};

export interface ChooseToolDeps {
  ensure: (id: string, options?: { for?: string }) => Promise<void>;
  setTool: (tool: Tool) => void;
  /** Called with anything `ensure` rejects with other than a decline. */
  onError: (err: unknown) => void;
}

/**
 * Choose a tool, asking for its model first. A tool with a model awaits `ensure` BEFORE `setTool`:
 * `Viewport.tsx`'s activation effect seeds the first `segment` request, so arming first would send
 * it without the model. A decline leaves the current tool in place; so does any other failure,
 * which is also reported. Any future shortcut for a model tool goes through here too.
 */
export async function chooseTool(tool: Tool, deps: ChooseToolDeps): Promise<void> {
  const model = TOOL_MODELS[tool];
  if (model) {
    try {
      await deps.ensure(model.id, { for: model.for });
    } catch (err) {
      if (!(err instanceof ModelDeclined)) deps.onError(err);
      return;
    }
  }
  deps.setTool(tool);
}

/**
 * Toolbar rail: one button per `Tool`. Left rail placeholder in
 * `app/Layout.tsx` this replaces. Marquee buttons were disabled placeholders
 * until this story — live as of `marquees.md` (`Viewport.tsx` wires the
 * drag/handle behaviour, `marquees/marqueeState.ts` holds the active
 * marquee). `select-smart` (Epic 17, segment-to-vector.md) and
 * `select-colour` (Epic 17 story 2b, colour-range-select.md) are both
 * `sidecarGated`: disabled with an honest hint until the sidecar is up —
 * `select-colour` needs no model/weights at all, but still runs IN the
 * sidecar (pure NumPy), not the webview, so the gate is the same.
 */
export function ToolbarRail() {
  const tool = useToolStateStore((s) => s.tool);
  const setTool = useToolStateStore((s) => s.setTool);
  const { ensure } = useModelGate();
  const sidecarUp = useSidecarStatusStore((s) => s.status === 'up');

  return (
    <div className="flex flex-col items-center gap-1">
      {TOOLS.map(({ tool: t, label, icon: Icon, disabled, sidecarGated, disabledHint }) => {
        const gatedOff = sidecarGated ? !sidecarUp : false;
        const effectiveDisabled = gatedOff || disabled;
        const effectiveLabel = gatedOff ? (disabledHint ?? label) : label;
        return (
          <Tooltip key={t}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={effectiveLabel}
                  aria-pressed={tool === t}
                  disabled={effectiveDisabled}
                  className={`flex h-8 w-8 items-center justify-center rounded ${
                    tool === t
                      ? 'bg-neutral-700 text-neutral-50'
                      : 'text-neutral-400 hover:bg-neutral-800'
                  } disabled:opacity-30 disabled:hover:bg-transparent`}
                  onClick={() =>
                    void chooseTool(t, {
                      ensure,
                      setTool,
                      onError: (err) => console.error(`[models] could not prepare ${t}:`, err),
                    })
                  }
                />
              }
            >
              <Icon size={16} />
            </TooltipTrigger>
            <TooltipContent side="right">{effectiveLabel}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
