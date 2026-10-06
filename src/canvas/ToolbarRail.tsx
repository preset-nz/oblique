import {
  Circle,
  Hand,
  Lasso,
  Move,
  PenTool as PenToolIcon,
  Pipette,
  Square,
  Type as TypeIcon,
  Wand2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidecarStatusStore } from '@/sidecar/client';
import { type Tool, useToolStateStore } from './toolState';

interface ToolButtonSpec {
  tool: Tool;
  label: string;
  icon: typeof Hand;
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
  { tool: 'pan', label: 'Pan', icon: Hand },
  { tool: 'move', label: 'Move (V)', icon: Move },
  { tool: 'select-rect', label: 'Rectangle select (M)', icon: Square },
  { tool: 'select-ellipse', label: 'Ellipse select', icon: Circle },
  { tool: 'select-lasso', label: 'Lasso select', icon: Lasso },
  {
    tool: 'select-smart',
    label: 'Smart select — click an object; Alt-click to exclude; drag a box',
    icon: Wand2,
    sidecarGated: true,
    disabledHint: 'Smart select — Sidecar not running',
  },
  {
    tool: 'select-colour',
    label: 'Colour select — click a colour; Alt-click to exclude; Shift-click adds',
    icon: Pipette,
    sidecarGated: true,
    disabledHint: 'Colour select — Sidecar not running',
  },
  { tool: 'pen', label: 'Pen', icon: PenToolIcon },
  { tool: 'text', label: 'Text (T)', icon: TypeIcon },
];

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
                  onClick={() => setTool(t)}
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
