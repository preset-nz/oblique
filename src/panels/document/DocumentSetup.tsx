import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSceneStore } from '@/scene/store';
import { ASPECT_PRESETS, describeDocumentSize, nextDocumentSize, type Orientation } from './aspect';

/**
 * Document setup — aspect preset + orientation. Applies to empty documents
 * and post-hoc: sets `scene.documentSize` only (`setDocumentSize` is
 * compositing-only, no dirty flag — dirty rule 4 in scene/store.ts), so
 * picking a preset recomposites without recooking any node.
 */
export function DocumentSetup() {
  const documentSize = useSceneStore((s) => s.scene.documentSize);
  const setDocumentSize = useSceneStore((s) => s.setDocumentSize);
  const { presetId, orientation } = describeDocumentSize(documentSize);

  const applyPreset = (nextPresetId: string) => {
    const preset = ASPECT_PRESETS.find((p) => p.id === nextPresetId);
    if (!preset) return;
    setDocumentSize(nextDocumentSize(documentSize, preset, orientation));
  };

  const applyOrientation = (nextOrientation: Orientation) => {
    const preset = ASPECT_PRESETS.find((p) => p.id === presetId) ?? ASPECT_PRESETS[0];
    setDocumentSize(nextDocumentSize(documentSize, preset, nextOrientation));
  };

  const [w, h] = documentSize;
  const sizeLabel = w > 0 && h > 0 ? `${w} × ${h}` : 'no document';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-xs text-neutral-400 hover:text-neutral-100 whitespace-nowrap"
        >
          {sizeLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="flex flex-col gap-3">
          <div className="text-xs font-medium text-neutral-300">Document setup</div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Aspect</span>
            <ToggleGroup
              type="single"
              value={presetId ?? undefined}
              onValueChange={(value) => value && applyPreset(value)}
            >
              {ASPECT_PRESETS.map((preset) => (
                <ToggleGroupItem key={preset.id} value={preset.id} aria-label={preset.label}>
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Orientation</span>
            <ToggleGroup
              type="single"
              value={orientation}
              onValueChange={(value) => value && applyOrientation(value as Orientation)}
            >
              <ToggleGroupItem value="landscape" aria-label="Landscape">
                Landscape
              </ToggleGroupItem>
              <ToggleGroupItem value="portrait" aria-label="Portrait">
                Portrait
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
