import { SnackbarProvider, SnackbarViewport } from '@preset.nz/ux-kit';
import { useEffect, useState } from 'react';
import { StatusBar } from '@/app/StatusBar';
import { PRODUCT_NAME } from '@/branding';
import { ToolbarRail } from '@/canvas/ToolbarRail';
import { Viewport } from '@/canvas/Viewport';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DocumentSetup } from '@/panels/document/DocumentSetup';
import { ExportProofDialog } from '@/panels/export/ExportProofDialog';
import { MissingFontsDialog } from '@/panels/fonts/MissingFontsDialog';
import { ReplaceFontDialog } from '@/panels/fonts/ReplaceFontDialog';
import { NotesPanel } from '@/panels/notes/NotesPanel';
import { StackPanel } from '@/panels/StackPanel';
import { SettingsDialog } from '@/panels/settings/SettingsDialog';
import { VectorsPanel } from '@/panels/VectorsPanel';
import { useTextEditStore } from '@/scene/textEditState';

export function Layout() {
  // Controlled so a request to focus the Text field (T-click, double-click,
  // Enter: dogfood-revisions.md) can bring the Stack tab forward first.
  const [tab, setTab] = useState('stack');
  useEffect(
    () =>
      useTextEditStore.subscribe((state, prev) => {
        if (state.focusRequest !== prev.focusRequest) setTab('stack');
      }),
    [],
  );

  return (
    <SnackbarProvider>
      <TooltipProvider>
        <div className="relative flex flex-col h-screen bg-neutral-950 text-neutral-50">
          {/* Title bar */}
          <div className="border-b border-neutral-800 px-4 py-3 flex items-center gap-3">
            <span className="text-sm font-medium">{PRODUCT_NAME}</span>
            <div className="flex-1" />
            <DocumentSetup />
          </div>

          {/* Main grid */}
          <div className="flex flex-1 overflow-hidden">
            {/* Left rail: 48px */}
            <div className="w-12 border-r border-neutral-800 flex flex-col items-center py-4">
              <ToolbarRail />
            </div>

            {/* Centre: flexible */}
            <div className="flex-1 overflow-hidden">
              <Viewport />
            </div>

            {/* Right panel: 320px */}
            <div className="w-80 border-l border-neutral-800 flex flex-col">
              <Tabs
                value={tab}
                onValueChange={setTab}
                className="flex flex-1 flex-col overflow-hidden"
              >
                <TabsList className="w-full rounded-none border-b border-neutral-800">
                  <TabsTrigger value="stack">Stack</TabsTrigger>
                  <TabsTrigger value="vectors">Vectors</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                  <TabsTrigger value="notes">Notes</TabsTrigger>
                </TabsList>
                <TabsContent value="stack" className="flex-1 overflow-auto p-4">
                  <StackPanel />
                </TabsContent>
                <TabsContent value="vectors" className="flex-1 overflow-auto p-4">
                  <VectorsPanel />
                </TabsContent>
                <TabsContent value="history" className="flex-1 overflow-hidden p-4">
                  <div className="text-neutral-500 text-sm">History content</div>
                </TabsContent>
                <TabsContent value="notes" className="flex-1 overflow-hidden p-4">
                  <NotesPanel />
                </TabsContent>
              </Tabs>
            </div>
          </div>

          {/* Status bar */}
          <StatusBar />
          <SnackbarViewport className="bottom-10" />
        </div>
        <SettingsDialog />
        <ExportProofDialog />
        <MissingFontsDialog />
        <ReplaceFontDialog />
      </TooltipProvider>
    </SnackbarProvider>
  );
}
