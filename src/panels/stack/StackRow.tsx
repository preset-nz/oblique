import { PropertyPanel } from '@preset.nz/property-editors';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  MoreVertical,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSceneStore } from '@/scene/store';
import type { Modifier, SceneNode } from '@/scene/types';
import type { OpDescriptor } from '@/sidecar/opsCache';
import { modifierScopeKey } from './modifierScope';
import { useRowCollapseStore } from './rowCollapse';
import { nudgeModelIndex } from './stackOrder';

interface StackRowProps {
  node: SceneNode;
  modifier: Modifier;
  /** This row's index in the DISPLAYED (bottom-to-top) list, not the scene-model array. */
  displayIndex: number;
  /** Total row count — same in both orderings. */
  length: number;
  ops: OpDescriptor[];
}

/**
 * One modifier row: reorder nudge (drag handle icon, up/down — see the
 * story's fallback note: pointer-drag DnD is out of this story's budget,
 * so the reorder control reuses `LayerList`'s up/down nudge pattern),
 * enabled toggle, label, expand chevron, overflow (duplicate/delete/reset).
 * The expanded region mounts `<PropertyPanel>` scoped to this modifier.
 */
export function StackRow({ node, modifier, displayIndex, length, ops }: StackRowProps) {
  const setModifierEnabled = useSceneStore((s) => s.setModifierEnabled);
  const reorderModifier = useSceneStore((s) => s.reorderModifier);
  const removeModifier = useSceneStore((s) => s.removeModifier);
  const addModifier = useSceneStore((s) => s.addModifier);
  const setModifierParam = useSceneStore((s) => s.setModifierParam);
  const expanded = useRowCollapseStore((s) => s.isExpanded(modifier.id));
  const toggleExpanded = useRowCollapseStore((s) => s.toggle);

  const descriptor = ops.find((o) => o.name === modifier.type);
  const up = nudgeModelIndex(displayIndex, 'up', length);
  const down = nudgeModelIndex(displayIndex, 'down', length);

  function resetParams() {
    if (!descriptor) return;
    for (const spec of descriptor.params) {
      setModifierParam(node.id, modifier.id, spec.name, spec.default as number | string | boolean);
    }
  }

  function duplicate() {
    addModifier(node.id, modifier.type, { ...modifier.params });
  }

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40">
      <div
        className={`flex items-center gap-1.5 px-1.5 py-1 ${modifier.enabled ? '' : 'opacity-40'}`}
      >
        <div className="flex flex-col text-neutral-500">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={up === null}
                aria-label="Move modifier up (applies later)"
                className="leading-none disabled:opacity-30"
                onClick={() => up !== null && reorderModifier(node.id, modifier.id, up)}
              >
                ▲
              </button>
            </TooltipTrigger>
            <TooltipContent>Applies later</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={down === null}
                aria-label="Move modifier down (applies earlier)"
                className="leading-none disabled:opacity-30"
                onClick={() => down !== null && reorderModifier(node.id, modifier.id, down)}
              >
                ▼
              </button>
            </TooltipTrigger>
            <TooltipContent>Applies earlier</TooltipContent>
          </Tooltip>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={modifier.enabled ? 'Disable modifier' : 'Enable modifier'}
              onClick={() => setModifierEnabled(node.id, modifier.id, !modifier.enabled)}
            >
              {modifier.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{modifier.enabled ? 'Disable' : 'Enable'}</TooltipContent>
        </Tooltip>

        <button
          type="button"
          className="flex flex-1 items-center gap-1 truncate text-left text-xs"
          onClick={() => toggleExpanded(modifier.id)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="truncate">{modifier.type}</span>
        </button>

        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button type="button" aria-label="Modifier options" className="text-neutral-500">
                  <MoreVertical size={14} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>Options</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-40 p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800"
              onClick={duplicate}
            >
              <Copy size={12} /> Duplicate
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800"
              onClick={resetParams}
            >
              <RotateCcw size={12} /> Reset params
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-red-400 hover:bg-neutral-800"
              onClick={() => removeModifier(node.id, modifier.id)}
            >
              <Trash2 size={12} /> Delete
            </button>
          </PopoverContent>
        </Popover>
      </div>

      {expanded && (
        <div className="border-t border-neutral-800">
          <PropertyPanel
            scopeKey={modifierScopeKey(modifier.type)}
            selection={{ nodeId: node.id, modId: modifier.id }}
            ctx={null}
            emptyState={
              <div className="px-3 py-2 text-xs text-neutral-500">
                Unknown op "{modifier.type}" — sidecar hasn't reported its params yet.
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}
