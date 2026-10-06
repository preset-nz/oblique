import { Icons } from '@preset.nz/ux-kit';
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSceneStore } from '@/scene/store';
import type { Modifier } from '@/scene/types';
import type { OpDescriptor } from '@/sidecar/opsCache';
import { opLabel } from '@/sidecar/opsCache';
import { useRowCollapseStore } from './rowCollapse';

function defaultParamsFor(descriptor: OpDescriptor): Modifier['params'] {
  const params: Modifier['params'] = {};
  for (const p of descriptor.params) params[p.name] = p.default as number | string | boolean;
  return params;
}

/**
 * Add-modifier button + searchable popover (epic README "Add-modifier
 * flow"). Sits at the displayed TOP of the stack — the scene-model
 * `addModifier` action already appends at the end of `node.modifiers`,
 * which is exactly the "last applied" / displayed-top position (see
 * `stackOrder.ts`), so no index math is needed here.
 */
export function AddModifier({
  nodeId,
  ops,
  disabled = false,
}: {
  nodeId: string;
  ops: OpDescriptor[];
  /** Locked target (lock-ui.md) — disables the add action, no popover. */
  disabled?: boolean;
}) {
  const addModifier = useSceneStore((s) => s.addModifier);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    // debug_-prefixed ops are protocol internals (debug_echo is the
    // round-trip canary) — real, registered, but never user-addable.
    const usable = ops.filter((op) => !op.name.startsWith('debug_'));
    const q = query.trim().toLowerCase();
    if (!q) return usable;
    return usable.filter(
      (op) => op.name.toLowerCase().includes(q) || opLabel(op).toLowerCase().includes(q),
    );
  }, [ops, query]);

  function pick(descriptor: OpDescriptor) {
    const modId = addModifier(nodeId, descriptor.name, defaultParamsFor(descriptor));
    useRowCollapseStore.getState().expand(modId);
    setOpen(false);
    setQuery('');
  }

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        if (disabled) return;
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  disabled={disabled}
                  aria-label="Add modifier"
                  className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-neutral-700 py-1.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-700 disabled:hover:text-neutral-400"
                />
              }
            />
          }
        >
          <Icons.PlusIcon size={14} />
          Add modifier
        </TooltipTrigger>
        <TooltipContent>
          {disabled ? 'Locked — unlock to edit' : 'Add a modifier to the top of the stack'}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 p-2">
        <Input
          autoFocus
          placeholder="Search ops…"
          aria-label="Search ops"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered[0]) {
              e.preventDefault();
              pick(filtered[0]);
            }
          }}
        />
        <div className="mt-2 flex max-h-56 flex-col gap-0.5 overflow-auto">
          {ops.length === 0 && (
            <div className="px-2 py-1 text-xs text-neutral-500">
              No ops available (sidecar not connected yet).
            </div>
          )}
          {ops.length > 0 && filtered.length === 0 && (
            <div className="px-2 py-1 text-xs text-neutral-500">No ops match "{query}".</div>
          )}
          {filtered.map((op) => (
            <button
              key={op.name}
              type="button"
              className="flex flex-col rounded px-2 py-1 text-left hover:bg-neutral-800"
              onClick={() => pick(op)}
            >
              <span className="text-xs">{opLabel(op)}</span>
              {op.description && (
                <span className="truncate text-[10px] text-neutral-500">{op.description}</span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
