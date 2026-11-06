import { Icons } from '@preset.nz/ux-kit';
import { InputNumber } from '@/components/InputNumber';
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSceneStore } from '@/scene/store';
import { beginTransaction, endTransaction } from '@/scene/transaction';
import { isPixelNode, type PixelMaskRef } from '@/scene/types';

/** How a driver layer is read: the channel, the levels and Invert. A mask's and a driver's alike. */
export type LayerReading = Pick<PixelMaskRef, 'channel' | 'low' | 'high' | 'invert'>;

/** What a new layer mask starts with: luminance, the full range, not inverted. */
export const DEFAULT_LAYER_MASK: LayerReading = {
  channel: 'luminance',
  low: 0,
  high: 1,
  invert: false,
};

interface PickerProps {
  /** Why a layer can't be picked (the cycle rule, worded for what is being attached), or null. */
  refusal: (layerId: string) => string | null;
  /** The reading already in place, kept when another layer is picked; else `DEFAULT_LAYER_MASK`. */
  current: LayerReading | undefined;
  locked: boolean;
  onPick: (layerId: string, reading: LayerReading) => void;
  onPicked: () => void;
}

/**
 * The layer picker behind "Mask from layer" and "Blur follows a layer" (layer-as-driver.md,
 * Epic 27): every pixel layer, hidden ones too (a hidden layer still drives). A layer that would
 * close a cycle stays in the list, disabled, with the reason under it. Picking one keeps the
 * channel, levels and invert already in place, else starts from `DEFAULT_LAYER_MASK`. What is
 * attached, and the cycle rule's wording, come from the caller.
 */
export function LayerMaskPicker({ refusal, current, locked, onPick, onPicked }: PickerProps) {
  const scene = useSceneStore((s) => s.scene);

  function pick(layerId: string) {
    if (locked) return;
    onPick(layerId, current ?? DEFAULT_LAYER_MASK);
    onPicked();
  }

  return (
    <div className="ml-4 flex flex-col gap-1 border-l border-neutral-800 pl-2">
      {scene.nodes.filter(isPixelNode).map((layer) => {
        const why = refusal(layer.id);
        return (
          <button
            key={layer.id}
            type="button"
            disabled={why !== null}
            className="flex flex-col rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:hover:bg-transparent"
            onClick={() => pick(layer.id)}
          >
            <span className={`truncate ${why ? 'opacity-40' : ''}`}>
              {layer.visible ? (
                <Icons.ImageIcon size={12} className="mr-1 inline" />
              ) : (
                <Icons.EyeSlashIcon size={12} className="mr-1 inline" aria-label="Hidden" />
              )}
              {layer.label}
            </span>
            {why && <span className="text-[10px] text-neutral-500">{why}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The live settings of a driver layer, a mask's or an op's: which channel is read, the levels
 * that map to no effect (Low) and full effect (High), and Invert. Each edits the binding in
 * place through `onChange`, so the consumer recooks as the value moves; a scrub is one undo step.
 * `caption` is the line over the controls ("Driven by ...").
 */
export function LayerMaskSettings({
  idPrefix,
  layerId,
  reading,
  locked,
  caption,
  onChange,
}: {
  /** Keeps the Invert checkbox's id apart from another reading on the same modifier. */
  idPrefix: string;
  layerId: string;
  reading: LayerReading;
  locked: boolean;
  caption: string;
  onChange: (next: LayerReading) => void;
}) {
  const driver = useSceneStore((s) => s.scene.nodes.find((n) => n.id === layerId));

  function set(patch: Partial<LayerReading>) {
    if (locked) return;
    onChange({ ...reading, ...patch });
  }

  return (
    <div className={`flex flex-col gap-1 px-2 py-1 ${locked ? 'opacity-40' : ''}`}>
      <span className="truncate text-xs text-neutral-400">
        {caption} {driver ? `“${driver.label}”` : 'a missing layer'}
      </span>
      <ToggleGroup
        size="sm"
        spacing={0}
        value={[reading.channel]}
        disabled={locked}
        onValueChange={([next]) => {
          if (next === 'luminance' || next === 'alpha') set({ channel: next });
        }}
      >
        <ToggleGroupItem value="luminance" className="px-2 text-xs">
          Luminance
        </ToggleGroupItem>
        <ToggleGroupItem value="alpha" className="px-2 text-xs">
          Alpha
        </ToggleGroupItem>
      </ToggleGroup>
      <InputNumber
        label="Low"
        description="The level of the driver that gives no effect."
        value={reading.low}
        min={0}
        max={1}
        step={0.01}
        disabled={locked}
        onDragStart={beginTransaction}
        onDragEnd={endTransaction}
        onChange={(low) => set({ low })}
      />
      <InputNumber
        label="High"
        description="The level of the driver that gives the full effect."
        value={reading.high}
        min={0}
        max={1}
        step={0.01}
        disabled={locked}
        onDragStart={beginTransaction}
        onDragEnd={endTransaction}
        onChange={(high) => set({ high })}
      />
      <label htmlFor={`${idPrefix}-invert`} className="flex items-center gap-2 text-xs">
        <Checkbox
          id={`${idPrefix}-invert`}
          className="border-neutral-500"
          disabled={locked}
          checked={reading.invert}
          onCheckedChange={(checked) => set({ invert: checked === true })}
        />
        Invert
      </label>
    </div>
  );
}
