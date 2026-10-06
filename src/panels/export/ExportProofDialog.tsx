import { create } from 'zustand';
import { InputNumber } from '@/components/InputNumber';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { exportProof } from '@/project/export';
import {
  defaultProofMargin,
  type ProofBarEdge,
  type ProofBarSteps,
  type ProofPaper,
} from '@/project/proofSheet';
import { useSceneStore } from '@/scene/store';

/**
 * File → Export Proof… (registration-marks-and-colour-bars.md): print-proof
 * options for an export that wraps the work area in a margin carrying
 * registration marks and colour bars. Plain "Export PNG…" stays plain — this
 * is a separate command. The options live for the session only (a small
 * store, nothing persisted); `margin: null` means "the default for the
 * current document" (8 % of the short edge), so it follows document resizes
 * until the person types a value.
 */
export interface ProofDialogOptions {
  margin: number | null;
  paper: ProofPaper;
  marks: boolean;
  edgeMarks: boolean;
  bars: boolean;
  steps: ProofBarSteps;
  barEdge: ProofBarEdge;
}

export const DEFAULT_PROOF_OPTIONS: ProofDialogOptions = {
  margin: null,
  paper: 'white',
  marks: true,
  edgeMarks: false,
  bars: true,
  steps: 5,
  barEdge: 'bottom',
};

interface ExportProofDialogState {
  open: boolean;
  options: ProofDialogOptions;
  setOpen: (open: boolean) => void;
  setOptions: (patch: Partial<ProofDialogOptions>) => void;
}

export const useExportProofDialogStore = create<ExportProofDialogState>((set) => ({
  open: false,
  options: DEFAULT_PROOF_OPTIONS,
  setOpen: (open) => set({ open }),
  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
}));

/** File → Export Proof… */
export function openExportProofDialog(): void {
  useExportProofDialogStore.getState().setOpen(true);
}

const MAX_MARGIN = 4096;

export function ExportProofDialog() {
  const open = useExportProofDialogStore((s) => s.open);
  const setOpen = useExportProofDialogStore((s) => s.setOpen);
  const options = useExportProofDialogStore((s) => s.options);
  const setOptions = useExportProofDialogStore((s) => s.setOptions);
  const documentSize = useSceneStore((s) => s.scene.documentSize);

  const margin = options.margin ?? defaultProofMargin(documentSize[0], documentSize[1]);

  const doExport = () => {
    setOpen(false);
    void exportProof(options);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export Proof</DialogTitle>
          <DialogDescription>
            A PNG with a margin around the image, carrying registration marks and colour bars. The
            image itself is exactly what Export PNG produces.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <InputNumber
            label="Margin (px)"
            value={margin}
            min={0}
            max={MAX_MARGIN}
            onChange={(v) => setOptions({ margin: Math.round(v) })}
          />

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Paper</span>
            <ToggleGroup
              value={[options.paper]}
              onValueChange={([v]) => v && setOptions({ paper: v as ProofPaper })}
            >
              <ToggleGroupItem value="white" aria-label="White paper">
                White
              </ToggleGroupItem>
              <ToggleGroupItem value="transparent" aria-label="Transparent paper">
                Transparent
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="proof-marks" className="flex items-center gap-2">
              <Checkbox
                id="proof-marks"
                className="border-neutral-500"
                checked={options.marks}
                onCheckedChange={(c) => setOptions({ marks: c === true })}
              />
              Registration marks
            </label>
            <label
              htmlFor="proof-edge-marks"
              className="flex items-center gap-2 pl-6 aria-disabled:opacity-50"
              aria-disabled={!options.marks}
            >
              <Checkbox
                id="proof-edge-marks"
                className="border-neutral-500"
                disabled={!options.marks}
                checked={options.edgeMarks}
                onCheckedChange={(c) => setOptions({ edgeMarks: c === true })}
              />
              Also at the edge centres
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="proof-bars" className="flex items-center gap-2">
              <Checkbox
                id="proof-bars"
                className="border-neutral-500"
                checked={options.bars}
                onCheckedChange={(c) => setOptions({ bars: c === true })}
              />
              Colour bars
            </label>
            <div className="flex flex-wrap items-center gap-4 pl-6">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-neutral-500">Steps</span>
                <ToggleGroup
                  value={[String(options.steps)]}
                  disabled={!options.bars}
                  onValueChange={([v]) => v && setOptions({ steps: Number(v) as ProofBarSteps })}
                >
                  {[3, 5, 7].map((n) => (
                    <ToggleGroupItem key={n} value={String(n)} aria-label={`${n} steps`}>
                      {n}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-neutral-500">Edge</span>
                <ToggleGroup
                  value={[options.barEdge]}
                  disabled={!options.bars}
                  onValueChange={([v]) => v && setOptions({ barEdge: v as ProofBarEdge })}
                >
                  <ToggleGroupItem value="bottom" aria-label="Bottom edge">
                    Bottom
                  </ToggleGroupItem>
                  <ToggleGroupItem value="right" aria-label="Right edge">
                    Right
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded border border-neutral-600 bg-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-600"
            onClick={doExport}
          >
            Export…
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
