import { ModelsSection } from '@preset.nz/app-kit/models';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { HealthResult } from '@/ai/adapter';
import { drawThingsDriver } from '@/ai/drawthings';
import { setDrawThingsEndpoint, useAiSettingsStore } from '@/ai/settings';
import { PRODUCT_NAME } from '@/branding';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Settings dialog (Epic 17 story 1 — the second tenant of the "Settings
 * dialog" roadmap gap, the first being cook-timing toggles). Two groups: "AI backends"
 * (the Draw Things endpoint and a Test connection check) and "Models" (Epic 17 story 2c,
 * model-downloads.md: app-kit's list of downloaded models, with Remove). Models moves into the
 * preferences Settings window when Oblique takes preferences (app-kit's README, the
 * `extraGroups` recipe). Opened from the native app menu (`Oblique → Settings…`, Cmd+,)
 * via `openSettingsDialog`, wired in `src/app/menu.ts` like every other command
 * of Oblique's that app-kit's table does not run itself.
 *
 * Saves on blur/Enter — no Save button, per the story's acceptance.
 */
interface SettingsDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useSettingsDialogStore = create<SettingsDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openSettingsDialog(): void {
  useSettingsDialogStore.getState().setOpen(true);
}

export function SettingsDialog() {
  const open = useSettingsDialogStore((s) => s.open);
  const setOpen = useSettingsDialogStore((s) => s.setOpen);
  const endpoint = useAiSettingsStore((s) => s.settings.drawThings.endpoint);

  const [draft, setDraft] = useState(endpoint);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<HealthResult | null>(null);

  // Re-sync the draft field to the persisted value on the closed->open
  // transition only — picks up settings loaded after the dialog was first
  // mounted, and discards any uncommitted typing from a previous session.
  // Reads the store directly (not the reactive `endpoint` above) and
  // depends on `open` alone so a save that happens *while* the dialog is
  // open (e.g. Test connection's own commit, below) can't re-fire this and
  // race the `setResult` that follows it.
  useEffect(() => {
    if (open) {
      setDraft(useAiSettingsStore.getState().settings.drawThings.endpoint);
      setResult(null);
    }
  }, [open]);

  const commit = () => {
    if (draft !== endpoint) void setDrawThingsEndpoint(draft);
  };

  const testConnection = async () => {
    if (draft !== endpoint) await setDrawThingsEndpoint(draft);
    setTesting(true);
    setResult(null);
    try {
      setResult(await drawThingsDriver.health());
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            AI backends — where {PRODUCT_NAME} looks for an image server it doesn't run itself — and
            the models it has downloaded.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="text-xs font-medium text-neutral-300">AI backends</div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="drawthings-endpoint">Draw Things endpoint</Label>
            <Input
              id="drawthings-endpoint"
              placeholder="http://127.0.0.1:7860"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commit();
                  e.currentTarget.blur();
                }
              }}
            />

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                className="rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void testConnection()}
                disabled={testing}
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>

              {result && (
                <span className="flex items-center gap-1.5 text-xs text-neutral-300">
                  <span
                    className={cn(
                      'inline-block size-2 rounded-full',
                      result.ok ? 'bg-green-500' : 'bg-red-500',
                    )}
                    aria-hidden
                  />
                  {result.detail}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium text-neutral-300">Models</div>
            <ModelsSection />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
