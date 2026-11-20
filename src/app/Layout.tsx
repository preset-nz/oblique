import { ModelPromptHost } from '@preset.nz/app-kit/models';
import {
  Icons,
  SidePanel,
  SnackbarProvider,
  SnackbarViewport,
  TooltipProvider,
} from '@preset.nz/ux-kit';
import { useEffect, useState } from 'react';
import type { Panels } from '@/app/panelState';
import { StatusBar } from '@/app/StatusBar';
import { ToolbarRail } from '@/canvas/ToolbarRail';
import { Viewport } from '@/canvas/Viewport';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DocumentSettingsDialog } from '@/panels/document/DocumentSettingsDialog';
import { ExportProofDialog } from '@/panels/export/ExportProofDialog';
import { MissingFontsDialog } from '@/panels/fonts/MissingFontsDialog';
import { ReplaceFontDialog } from '@/panels/fonts/ReplaceFontDialog';
import { LayersPanel } from '@/panels/LayersPanel';
import { NotesPanel } from '@/panels/notes/NotesPanel';
import { SelectionsPanel } from '@/panels/SelectionsPanel';
import { StackPanel } from '@/panels/StackPanel';
import { SettingsDialog } from '@/panels/settings/SettingsDialog';
import { useSelectionRepair } from '@/panels/stack/useSelectionRepair';
import { VectorsPanel } from '@/panels/VectorsPanel';
import { useTextEditStore } from '@/scene/textEditState';

// The kit's SidePanel is the sidebar colour; Oblique's panels sit on the same neutral as the rest
// of the window.
const PANEL_LOOK = 'bg-neutral-950 border-neutral-800';

export function Layout({ panels }: { panels: Panels }) {
  // Both tab sets are controlled, and held here rather than in the panels: a collapsed SidePanel
  // unmounts its children, and the tab you were on should be the one you come back to. The right
  // one also lets a request to focus the Text field (T-click, double-click, Enter:
  // dogfood-revisions.md) bring Properties forward first.
  const [leftTab, setLeftTab] = useState('layers');
  const [rightTab, setRightTab] = useState('properties');
  const setRightOpen = panels.right.panelProps.onOpenChange;
  useSelectionRepair();
  useEffect(
    () =>
      useTextEditStore.subscribe((state, prev) => {
        if (state.focusRequest === prev.focusRequest) return;
        // Text editing lands on the right: open the panel if it is collapsed, on Properties.
        setRightTab('properties');
        setRightOpen(true);
      }),
    [setRightOpen],
  );

  return (
    <SnackbarProvider>
      <TooltipProvider>
        <div className="relative flex flex-col h-screen bg-neutral-950 text-neutral-50">
          {/* Main grid: tool rail | layers | canvas | properties */}
          <div className="flex flex-1 overflow-hidden">
            {/* Tool rail: 48px, outside the layer panel (layers-left.md) */}
            <div className="w-12 shrink-0 border-r border-neutral-800 flex flex-col items-center py-4">
              <ToolbarRail />
            </div>

            <SidePanel
              side="left"
              title="Layers"
              icon={<Icons.StackIcon size={18} />}
              shortcut="⌘["
              className={PANEL_LOOK}
              {...panels.left.panelProps}
            >
              <Tabs
                value={leftTab}
                onValueChange={setLeftTab}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <TabsList className="w-full rounded-none border-b border-neutral-800">
                  <TabsTrigger value="layers">Layers</TabsTrigger>
                  <TabsTrigger value="selections">Selections</TabsTrigger>
                </TabsList>
                <TabsContent value="layers" className="min-h-0 flex-1 overflow-auto p-4">
                  <LayersPanel />
                </TabsContent>
                <TabsContent value="selections" className="min-h-0 flex-1 overflow-auto p-4">
                  <SelectionsPanel />
                </TabsContent>
              </Tabs>
            </SidePanel>

            {/* Centre: flexible */}
            <div className="min-w-0 flex-1 overflow-hidden">
              <Viewport />
            </div>

            <SidePanel
              side="right"
              title="Properties"
              icon={<Icons.SlidersHorizontalIcon size={18} />}
              shortcut="⌘]"
              className={PANEL_LOOK}
              {...panels.right.panelProps}
            >
              <Tabs
                value={rightTab}
                onValueChange={setRightTab}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <TabsList className="w-full rounded-none border-b border-neutral-800">
                  <TabsTrigger value="properties">Properties</TabsTrigger>
                  <TabsTrigger value="vectors">Vectors</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                  <TabsTrigger value="notes">Notes</TabsTrigger>
                </TabsList>
                <TabsContent value="properties" className="min-h-0 flex-1 overflow-auto p-4">
                  <StackPanel />
                </TabsContent>
                <TabsContent value="vectors" className="min-h-0 flex-1 overflow-auto p-4">
                  <VectorsPanel />
                </TabsContent>
                <TabsContent value="history" className="min-h-0 flex-1 overflow-hidden p-4">
                  <div className="text-neutral-500 text-sm">History content</div>
                </TabsContent>
                <TabsContent value="notes" className="min-h-0 flex-1 overflow-hidden p-4">
                  <NotesPanel />
                </TabsContent>
              </Tabs>
            </SidePanel>
          </div>

          {/* Status bar */}
          <StatusBar />
          <SnackbarViewport className="bottom-10" />
        </div>
        <SettingsDialog />
        {/* The download prompt `ensure` opens (ToolbarRail's Smart Select); once, near the root. */}
        <ModelPromptHost />
        <DocumentSettingsDialog />
        <ExportProofDialog />
        <MissingFontsDialog />
        <ReplaceFontDialog />
      </TooltipProvider>
    </SnackbarProvider>
  );
}
