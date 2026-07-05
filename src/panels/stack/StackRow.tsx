import { PropertyPanel } from '@preset.nz/property-editors';
import {
  Blend,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  MoreVertical,
  RotateCcw,
  Spline,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isMaskableMarquee, marqueeToMaskShape, useMarqueeStateStore } from '@/scene/marquee';
import { useSceneStore } from '@/scene/store';
import { IDENTITY_TRANSFORM_2D, isVectorNode, type Modifier, type SceneNode } from '@/scene/types';
import type { OpDescriptor } from '@/sidecar/opsCache';
import { opLabel } from '@/sidecar/opsCache';
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
  const setModifierMask = useSceneStore((s) => s.setModifierMask);
  const setModifierVectorMask = useSceneStore((s) => s.setModifierVectorMask);
  const removeModifierMask = useSceneStore((s) => s.removeModifierMask);
  const vectorNodes = useSceneStore((s) => s.scene.nodes.filter(isVectorNode));
  // Which kind of mask (if any) this modifier's maskId resolves to
  // (vector-modifier-masks.md's resolution rule: masks table first, then
  // maskRefs) — drives the Blend indicator's tooltip wording.
  const maskKind = useSceneStore((s) => {
    if (!modifier.maskId) return undefined;
    if (s.scene.masks?.[modifier.maskId]) return 'selection';
    if (s.scene.maskRefs?.[modifier.maskId]) return 'vector';
    return undefined;
  });
  const marquee = useMarqueeStateStore((s) => s.marquee);
  const rowExpanded = useRowCollapseStore((s) => s.isExpanded(modifier.id));
  const toggleExpanded = useRowCollapseStore((s) => s.toggle);
  const [vectorPickerOpen, setVectorPickerOpen] = useState(false);

  const descriptor = ops.find((o) => o.name === modifier.type);
  // Param-less ops (e.g. invert) have nothing to expand. An UNKNOWN op stays
  // expandable so the PropertyPanel empty state can explain itself.
  const expandable = !descriptor || descriptor.params.length > 0;
  const expanded = expandable && rowExpanded;
  const up = nudgeModelIndex(displayIndex, 'up', length);
  const down = nudgeModelIndex(displayIndex, 'down', length);

  function resetParams() {
    if (!descriptor) return;
    for (const spec of descriptor.params) {
      setModifierParam(node.id, modifier.id, spec.name, spec.default as number | string | boolean);
    }
  }

  function duplicate() {
    const modId = addModifier(node.id, modifier.type, { ...modifier.params });
    useRowCollapseStore.getState().expand(modId);
  }

  function maskFromSelection() {
    const state = useMarqueeStateStore.getState();
    const active = state.marquee;
    if (!isMaskableMarquee(active) || !active) return;
    // Snapshot the node's CURRENT transform: the mask glues itself to the
    // node pixels under the marquee right now, and moving the node later
    // must not re-rasterise or recook (epic acceptance) — see
    // MaskDef.appliedTransform2d in scene/types.ts.
    setModifierMask(node.id, modifier.id, {
      shape: marqueeToMaskShape(active),
      appliedTransform2d: node.transform2d ?? IDENTITY_TRANSFORM_2D,
      featherPx: state.params.featherPx,
      expand: state.params.expand,
      invert: state.params.invert,
    });
    // Consumed — same "no orphaned overlay state" rule as every other
    // marquee exit.
    state.clear();
  }

  /**
   * Attach a *live* vector reference (vector-modifier-masks.md): the
   * feather/expand/invert come from the SAME marquee-params store the
   * "mask from selection" flow reads — reusing its existing tuning UI
   * rather than building a second one, since the story's v1 scope has no
   * post-apply mask editor for either kind (deferred: a Vectors-tab-era
   * pass, per the epic's build order).
   */
  function maskFromVectorNode(vectorNodeId: string) {
    const params = useMarqueeStateStore.getState().params;
    // Snapshot THIS node's (the consumer's) current transform — same
    // reason as maskFromSelection's appliedTransform2d: the vector path is
    // document-space, but this node's own cook buffer is node-local, and
    // moving the consumer later must not re-rasterise or recook.
    setModifierVectorMask(node.id, modifier.id, vectorNodeId, {
      appliedTransform2d: node.transform2d ?? IDENTITY_TRANSFORM_2D,
      featherPx: params.featherPx,
      expand: params.expand,
      invert: params.invert,
    });
    setVectorPickerOpen(false);
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
          onClick={() => expandable && toggleExpanded(modifier.id)}
          aria-expanded={expandable ? expanded : undefined}
        >
          {expandable ? (
            expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            // Spacer keeps param-less rows' labels aligned with expandable ones.
            <span className="w-3.5 shrink-0" />
          )}
          <span className="truncate">{descriptor ? opLabel(descriptor) : modifier.type}</span>
          {modifier.maskId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Blend size={12} className="shrink-0 text-neutral-500" aria-label="Masked" />
              </TooltipTrigger>
              <TooltipContent>
                {maskKind === 'vector'
                  ? 'Masked — live vector reference; editing the shape recooks this modifier'
                  : 'Masked — this modifier affects only its region'}
              </TooltipContent>
            </Tooltip>
          )}
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
              disabled={!isMaskableMarquee(marquee)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={maskFromSelection}
            >
              <Blend size={12} />{' '}
              {modifier.maskId ? 'Replace mask from selection' : 'Mask from selection'}
            </button>
            <button
              type="button"
              disabled={vectorNodes.length === 0}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={() => setVectorPickerOpen((open) => !open)}
            >
              <Spline size={12} />{' '}
              {modifier.maskId ? 'Replace mask from vector node' : 'Mask from vector node'}
            </button>
            {vectorPickerOpen && (
              <div className="ml-4 flex flex-col border-l border-neutral-800 pl-2">
                {vectorNodes.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className="truncate rounded px-2 py-1 text-left text-xs hover:bg-neutral-800"
                    onClick={() => maskFromVectorNode(v.id)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            )}
            {modifier.maskId && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800"
                onClick={() => removeModifierMask(node.id, modifier.id)}
              >
                <Blend size={12} className="opacity-40" /> Remove mask
              </button>
            )}
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
