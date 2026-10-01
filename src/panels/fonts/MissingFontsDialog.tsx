import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fontLabel, useMissingFontsStore } from '@/fonts/missingFonts';
import { openReplaceFontDialog } from './ReplaceFontDialog';

const buttonClass =
  'rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800';

/**
 * The one-per-open warning (missing-fonts.md): which fonts were swapped and for
 * what. Modal but harmless: OK only closes it, and the document keeps its
 * wanted fonts either way. Replace Font… hands over to the Replace Font dialog.
 */
export function MissingFontsDialog() {
  const open = useMissingFontsStore((s) => s.warningOpen);
  const setOpen = useMissingFontsStore((s) => s.setWarningOpen);
  const missing = useMissingFontsStore((s) => s.missing);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Missing fonts</DialogTitle>
          <DialogDescription>
            These fonts aren't installed, so the closest installed font is shown instead. The
            document still remembers the original, so it comes back once the font is installed and
            the file is reopened.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1.5 text-sm">
          {missing.map((m) => (
            <li key={m.wanted.postscriptName}>
              <span className="font-medium">{fontLabel(m.wanted)}</span>
              {' → '}
              {m.substitute ? fontLabel(m.substitute) : 'no installed font available'}
              <span className="text-neutral-500">
                {' '}
                ({m.nodeIds.length} {m.nodeIds.length === 1 ? 'layer' : 'layers'})
              </span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setOpen(false);
              openReplaceFontDialog();
            }}
          >
            Replace Font…
          </button>
          <button type="button" className={buttonClass} onClick={() => setOpen(false)}>
            OK
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
