import { Icons } from '@preset.nz/ux-kit';
import { InputNumber } from '@/components/InputNumber';
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { driverRefusal } from '@/scene/maskInputs';
import { useSceneStore } from '@/scene/store';
import { beginTransaction, endTransaction } from '@/scene/transaction';
import {
  isPixelMaskRef,
  isPixelNode,
  type Modifier,
  type PixelMaskRef,
  type SceneNode,
} from '@/scene/types';

/** What a new layer mask starts with: luminance, the full range, not inverted. */
export const DEFAULT_LAYER_MASK: Omit<PixelMaskRef, 'id' | 'nodeId' | 'kind'> = {
  channel: 'luminance',
  low: 0,
  high: 1,
  invert: false,
};

interface Props {
  node: SceneNode;
  modifier: Modifier;
  locked: boolean;
  onPicked: () => void;
}

/**
 * "Mask from layer" (layer-as-driver.md): every pixel layer, hidden ones too (a hidden layer
 * still drives). A layer that would close a cycle stays in the list, disabled, with the reason
 * under it. Picking one keeps the channel, levels and invert of the layer mask the modifier
 * already has, else starts from `DEFAULT_LAYER_MASK`.
 */
export function LayerMaskPicker({ node, modifier, locked, onPicked }: Props) {
  const setModifierPixelMask = useSceneStore((s) => s.setModifierPixelMask);
  const scene = useSceneStore((s) => s.scene);
  const current = modifier.maskId ? scene.maskRefs?.[modifier.maskId] : undefined;
  const getNode = (id: string) => scene.nodes.find((n) => n.id === id);
  const getRef = (id: string) => scene.maskRefs?.[id];

  function pick(driverId: string) {
    if (locked) return;
    const numbers = isPixelMaskRef(current)
      ? { channel: current.channel, low: current.low, high: current.high, invert: current.invert }
      : DEFAULT_LAYER_MASK;
    setModifierPixelMask(node.id, modifier.id, driverId, numbers);
    onPicked();
  }

  return (
    <div className="ml-4 flex flex-col gap-1 border-l border-neutral-800 pl-2">
      {scene.nodes.filter(isPixelNode).map((layer) => {
        const refusal = driverRefusal(node.id, layer.id, getNode, getRef);
        return (
          <button
            key={layer.id}
            type="button"
            disabled={refusal !== null}
            className="flex flex-col rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:hover:bg-transparent"
            onClick={() => pick(layer.id)}
          >
            <span className={`truncate ${refusal ? 'opacity-40' : ''}`}>
              {layer.visible ? (
                <Icons.ImageIcon size={12} className="mr-1 inline" />
              ) : (
                <Icons.EyeSlashIcon size={12} className="mr-1 inline" aria-label="Hidden" />
              )}
              {layer.label}
            </span>
            {refusal && <span className="text-[10px] text-neutral-500">{refusal}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The live settings of a layer mask: which channel of the driver is read, the levels that map
 * to no effect (Low) and full effect (High), and Invert. Each edits the ref in place, so the
 * consumer recooks as the value moves; a scrub is one undo step.
 */
export function LayerMaskSettings({
  node,
  modifier,
  maskRef,
  locked,
}: {
  node: SceneNode;
  modifier: Modifier;
  maskRef: PixelMaskRef;
  locked: boolean;
}) {
  const setModifierPixelMask = useSceneStore((s) => s.setModifierPixelMask);
  const driver = useSceneStore((s) => s.scene.nodes.find((n) => n.id === maskRef.nodeId));

  function set(patch: Partial<Omit<PixelMaskRef, 'id' | 'nodeId' | 'kind'>>) {
    if (locked) return;
    const { channel, low, high, invert } = maskRef;
    setModifierPixelMask(node.id, modifier.id, maskRef.nodeId, {
      channel,
      low,
      high,
      invert,
      ...patch,
    });
  }

  return (
    <div className={`flex flex-col gap-1 px-2 py-1 ${locked ? 'opacity-40' : ''}`}>
      <span className="truncate text-xs text-neutral-400">
        Driven by {driver ? `“${driver.label}”` : 'a missing layer'}
      </span>
      <ToggleGroup
        size="sm"
        spacing={0}
        value={[maskRef.channel]}
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
        value={maskRef.low}
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
        value={maskRef.high}
        min={0}
        max={1}
        step={0.01}
        disabled={locked}
        onDragStart={beginTransaction}
        onDragEnd={endTransaction}
        onChange={(high) => set({ high })}
      />
      <label
        htmlFor={`layer-mask-invert-${modifier.id}`}
        className="flex items-center gap-2 text-xs"
      >
        <Checkbox
          id={`layer-mask-invert-${modifier.id}`}
          className="border-neutral-500"
          disabled={locked}
          checked={maskRef.invert}
          onCheckedChange={(checked) => set({ invert: checked === true })}
        />
        Invert
      </label>
    </div>
  );
}
