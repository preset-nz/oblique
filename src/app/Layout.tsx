import { PRODUCT_NAME } from '@/branding';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function Layout() {
  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-50">
      {/* Title bar */}
      <div className="border-b border-neutral-800 px-4 py-3 text-sm font-medium">
        {PRODUCT_NAME}
      </div>

      {/* Main grid */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left rail: 48px */}
        <div className="w-12 border-r border-neutral-800 flex flex-col items-center py-4">
          {/* Placeholder for future ToolButtons */}
        </div>

        {/* Centre: flexible */}
        <div className="flex-1 overflow-hidden">
          {/* Checkerboard pattern background */}
          <div
            className="w-full h-full"
            style={{
              backgroundImage: `
                linear-gradient(45deg, #1a1a1a 25%, transparent 25%),
                linear-gradient(-45deg, #1a1a1a 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #1a1a1a 75%),
                linear-gradient(-45deg, transparent 75%, #1a1a1a 75%)
              `,
              backgroundSize: '32px 32px',
              backgroundPosition: '0 0, 0 16px, 16px -16px, -16px 0px',
              backgroundColor: '#0f0f0f',
            }}
          />
        </div>

        {/* Right panel: 320px */}
        <div className="w-80 border-l border-neutral-800 flex flex-col">
          <Tabs defaultValue="stack" className="flex flex-1 flex-col overflow-hidden">
            <TabsList className="w-full rounded-none border-b border-neutral-800">
              <TabsTrigger value="stack">Stack</TabsTrigger>
              <TabsTrigger value="vectors">Vectors</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="stack" className="flex-1 overflow-hidden p-4">
              <div className="text-neutral-500 text-sm">Stack content</div>
            </TabsContent>
            <TabsContent value="vectors" className="flex-1 overflow-hidden p-4">
              <div className="text-neutral-500 text-sm">Vectors content</div>
            </TabsContent>
            <TabsContent value="history" className="flex-1 overflow-hidden p-4">
              <div className="text-neutral-500 text-sm">History content</div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
