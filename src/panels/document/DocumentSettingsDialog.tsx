import { create } from 'zustand';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DocumentFields } from './DocumentFields';

/**
 * File → Document Settings… (`Opt+Cmd+P`, Epic 22 slice d, menu standard decision 11): the
 * document's own fields in a dialog, their only home: the inspector doesn't show them (Georg,
 * 2026-10-14). Each edit applies at once, so there is no Save button.
 * Opened by `openDocumentSettingsDialog`, wired in `src/app/menu.ts`.
 */
interface DocumentSettingsDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useDocumentSettingsDialogStore = create<DocumentSettingsDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openDocumentSettingsDialog(): void {
  useDocumentSettingsDialogStore.getState().setOpen(true);
}

export function DocumentSettingsDialog() {
  const open = useDocumentSettingsDialogStore((s) => s.open);
  const setOpen = useDocumentSettingsDialogStore((s) => s.setOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Document Settings</DialogTitle>
          <DialogDescription>
            Size and background. Changes apply as you make them.
          </DialogDescription>
        </DialogHeader>
        <DocumentFields />
      </DialogContent>
    </Dialog>
  );
}
