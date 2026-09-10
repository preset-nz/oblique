import { Circle, Hand, Lasso, Move, PenTool as PenToolIcon, Square, Wand2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidecarStatusStore } from '@/sidecar/client';
import { type Tool, useToolStateStore } from './toolState';

interface ToolButtonSpec {
  tool: Tool;
  label: string;
  icon: typeof Hand;
  disabled?: boolean;
}

const SMART_SELECT_LABEL = 'Smart select — click an object; Alt-click to exclude; drag a box';
const SMART_SELECT_DISABLED_HINT = 'Smart select — Sidecar not running';

const TOOLS: ToolButtonSpec[] = [
  { tool: 'pan', label: 'Pan', icon: Hand },
  { tool: 'move', label: 'Move (V)', icon: Move },
  { tool: 'select-rect', label: 'Rectangle select (M)', icon: Square },
  { tool: 'select-ellipse', label: 'Ellipse select', icon: Circle },
  { tool: 'select-lasso', label: 'Lasso select', icon: Lasso },
  // Disabled state is computed per-render below (sidecar status), not baked
  // into this static list — the honest-disabled-hint rule (Epic 17
  // acceptance) needs the live connection status.
  { tool: 'select-smart', label: SMART_SELECT_LABEL, icon: Wand2 },
  { tool: 'pen', label: 'Pen', icon: PenToolIcon },
];

/**
 * Toolbar rail: one button per `Tool`. Left rail placeholder in
 * `app/Layout.tsx` this replaces. Marquee buttons were disabled placeholders
 * until this story — live as of `marquees.md` (`Viewport.tsx` wires the
 * drag/handle behaviour, `marquees/marqueeState.ts` holds the active
 * marquee). `select-smart` (Epic 17, segment-to-vector.md) is disabled with
 * an honest hint until the sidecar is up — MobileSAM runs there, not in the
 * webview.
 */
export function ToolbarRail() {
  const tool = useToolStateStore((s) => s.tool);
  const setTool = useToolStateStore((s) => s.setTool);
  const sidecarUp = useSidecarStatusStore((s) => s.status === 'up');

  return (
    <div className="flex flex-col items-center gap-1">
      {TOOLS.map(({ tool: t, label, icon: Icon, disabled }) => {
        const isSmartSelect = t === 'select-smart';
        const effectiveDisabled = isSmartSelect ? !sidecarUp : disabled;
        const effectiveLabel = isSmartSelect && !sidecarUp ? SMART_SELECT_DISABLED_HINT : label;
        return (
          <Tooltip key={t}>
            <TooltipTrigger asChild>
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
              >
                <Icon size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{effectiveLabel}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
