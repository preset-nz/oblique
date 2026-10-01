import { TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import { findUsedFonts, fontLabel, type UsedFont } from '@/fonts/missingFonts';
import { applyFontReplacements } from '@/fonts/replaceFont';
import { type FontRef, fontRefOf } from '@/fonts/types';
import { FontFamilyField, FontStyleField } from '@/panels/text/fontFieldRenderers';
import { fontForFamily } from '@/panels/text/textScope';
import { useSceneStore } from '@/scene/store';
import { isTextNode } from '@/scene/types';

interface ReplaceFontDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useReplaceFontDialogStore = create<ReplaceFontDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Type → Replace Font… (and the Missing fonts dialog's button). */
export function openReplaceFontDialog(): void {
  useReplaceFontDialogStore.getState().setOpen(true);
}

const buttonClass =
  'rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40';

/** What a row shows before it is touched: the substitute for a missing font, the font itself otherwise. */
const prefillOf = (u: UsedFont): FontRef => (u.missing && u.substitute) || u.wanted;

function Row({
  used,
  choice,
  onPick,
}: {
  used: UsedFont;
  choice: FontRef;
  onPick: (next: FontRef) => void;
}) {
  const faces = useFontCatalogueStore((s) => s.faces);
  const count = used.nodeIds.length;
  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-800 p-3">
      <div className="flex items-center gap-2 text-sm">
        {used.missing && (
          <TriangleAlert
            size={14}
            className="shrink-0 text-amber-400"
            role="img"
            aria-label="Missing"
          />
        )}
        <span className="min-w-0 truncate font-medium" title={fontLabel(used.wanted)}>
          {fontLabel(used.wanted)}
        </span>
        <span className="ml-auto shrink-0 text-xs text-neutral-500">
          {used.missing ? 'missing · ' : ''}
          {count} {count === 1 ? 'layer' : 'layers'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FontFamilyField
          label="Replace with"
          family={choice.family}
          disabled={false}
          onChange={(family) => {
            const next = fontForFamily(choice, family, faces);
            if (next) onPick(next);
          }}
        />
        <FontStyleField
          label="Style"
          font={choice}
          disabled={false}
          onChange={(postscriptName) => {
            const face = faces.find(
              (f) =>
                f.postscriptName === postscriptName &&
                f.family.toLowerCase() === choice.family.toLowerCase(),
            );
            if (face) onPick(fontRefOf(face));
          }}
        />
      </div>
    </div>
  );
}

/**
 * Per-document font remapping (missing-fonts.md): one row per font used in the
 * document, missing ones first. Replace applies every touched row in one undo
 * step; locked layers are skipped and counted.
 */
export function ReplaceFontDialog() {
  const open = useReplaceFontDialogStore((s) => s.open);
  const setOpen = useReplaceFontDialogStore((s) => s.setOpen);
  const nodes = useSceneStore((s) => s.scene.nodes);
  const faces = useFontCatalogueStore((s) => s.faces);
  const ready = useFontCatalogueStore((s) => s.status) === 'ready';
  // Keyed by wanted PostScript name; a row the user hasn't touched shows its
  // prefill (`prefillOf`).
  const [picks, setPicks] = useState<Record<string, FontRef>>({});

  const rows = useMemo(() => {
    const used = findUsedFonts(nodes.filter(isTextNode), faces);
    return [...used.filter((u) => u.missing), ...used.filter((u) => !u.missing)];
  }, [nodes, faces]);

  const choiceOf = (u: UsedFont): FontRef => picks[u.wanted.postscriptName] ?? prefillOf(u);
  // A row is "changed" when what it shows differs from the font the document
  // wants. A missing font's prefilled substitute therefore counts: Replace on an
  // untouched missing row makes the swap permanent ("keep the swap"), while an
  // installed font's untouched row shows itself and changes nothing.
  const changed = rows.filter((u) => choiceOf(u).postscriptName !== u.wanted.postscriptName);
  const lockedSkipped = changed.reduce(
    (n, u) =>
      n + u.nodeIds.filter((id) => nodes.find((node) => node.id === id)?.state === 'locked').length,
    0,
  );

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) setPicks({});
  };

  const apply = () => {
    const { replaced, skipped } = applyFontReplacements(
      changed.map((u) => ({
        fromPostscript: u.wanted.postscriptName,
        to: choiceOf(u),
      })),
    );
    close(false);
    if (skipped > 0) {
      toast.info(
        `Replaced the font on ${replaced} ${replaced === 1 ? 'layer' : 'layers'}; skipped ${skipped} locked ${skipped === 1 ? 'layer' : 'layers'}.`,
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Replace Font</DialogTitle>
          <DialogDescription>
            Choose a new font for any font used in this document. Missing fonts are listed first;
            their rows start on the font being shown instead.
          </DialogDescription>
        </DialogHeader>
        {!ready ? (
          <p className="text-sm text-neutral-400">Installed fonts aren't available.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-neutral-400">This document has no text layers.</p>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {rows.map((u) => (
              <Row
                key={u.wanted.postscriptName}
                used={u}
                choice={choiceOf(u)}
                onPick={(next) => setPicks((p) => ({ ...p, [u.wanted.postscriptName]: next }))}
              />
            ))}
          </div>
        )}
        {lockedSkipped > 0 && (
          <p className="text-xs text-amber-400">
            {lockedSkipped} locked {lockedSkipped === 1 ? 'layer' : 'layers'} will be skipped.
            Unlock {lockedSkipped === 1 ? 'it' : 'them'} first to replace the font there too.
          </p>
        )}
        <DialogFooter>
          <button type="button" className={buttonClass} onClick={() => close(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={changed.length === 0}
            onClick={apply}
          >
            Replace
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
