import { Circle, Hand, Lasso, Move, PenTool as PenToolIcon, Square } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type Tool, useToolStateStore } from './toolState';

interface ToolButtonSpec {
  tool: Tool;
  label: string;
  icon: typeof Hand;
  disabled?: boolean;
}

const TOOLS: ToolButtonSpec[] = [
  { tool: 'pan', label: 'Pan', icon: Hand },
  { tool: 'move', label: 'Move (V)', icon: Move },
  { tool: 'select-rect', label: 'Rectangle select (M)', icon: Square },
  { tool: 'select-ellipse', label: 'Ellipse select', icon: Circle },
  { tool: 'select-lasso', label: 'Lasso select', icon: Lasso },
  { tool: 'pen', label: 'Pen', icon: PenToolIcon },
];

/**
 * Toolbar rail: one button per `Tool`. Left rail placeholder in
 * `app/Layout.tsx` this replaces. Marquee buttons were disabled placeholders
 * until this story — live as of `marquees.md` (`Viewport.tsx` wires the
 * drag/handle behaviour, `marquees/marqueeState.ts` holds the active
 * marquee).
 */
export function ToolbarRail() {
  const tool = useToolStateStore((s) => s.tool);
  const setTool = useToolStateStore((s) => s.setTool);

  return (
    <div className="flex flex-col items-center gap-1">
      {TOOLS.map(({ tool: t, label, icon: Icon, disabled }) => (
        <Tooltip key={t}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={label}
              aria-pressed={tool === t}
              disabled={disabled}
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
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
