import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import { type CacheLookup, type Composite2DContext, compositeScene } from '@/compositor/composite';
import { cookNodeFullRes } from '@/cook/cook';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import { filenameOf } from './import';
import { useProjectMetaStore } from './io';

/** The subset of `OffscreenCanvas` export needs — satisfied by the real thing, stubbed in tests. */
export interface ExportCanvas {
  getContext(id: '2d'): Composite2DContext | null;
  convertToBlob(options: { type: string }): Promise<Blob>;
}

/**
 * File-system + browser edges injected for tests (same pattern as
 * `ImportDeps`/`ProjectIoDeps`).
 */
export interface ExportDeps {
  getScene: () => Scene;
  /** One-shot full-res cook of a single node — never a cache read, never a fallback. */
  cookFullRes: (nodeId: string) => Promise<ImageBitmap>;
  createCanvas: (width: number, height: number) => ExportCanvas;
  blobToBytes: (blob: Blob) => Promise<Uint8Array>;
  pickSavePath: (suggestedName: string) => Promise<string | null>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

function realCreateCanvas(width: number, height: number): ExportCanvas {
  return new OffscreenCanvas(width, height);
}

async function realBlobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function realPickSavePath(suggestedName: string): Promise<string | null> {
  return saveDialog({
    defaultPath: suggestedName,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
}

export const tauriExportDeps: ExportDeps = {
  getScene: () => useSceneStore.getState().scene,
  cookFullRes: (nodeId) => cookNodeFullRes(nodeId),
  createCanvas: realCreateCanvas,
  blobToBytes: realBlobToBytes,
  pickSavePath: realPickSavePath,
  writeFile,
};

/** Suggested export filename, derived from the current project path (or a generic default). */
export function suggestedExportName(projectPath: string | null): string {
  if (!projectPath) return 'untitled.png';
  const base = filenameOf(projectPath).replace(/\.oblique$/i, '');
  return `${base || 'untitled'}.png`;
}

/** Visible, image-output nodes — the only ones export cooks and composites (architecture §Compositor). */
export function exportableNodes(scene: Scene) {
  return scene.nodes.filter((n) => n.visible && n.output === 'image');
}

export interface ExportProgress {
  done: number;
  total: number;
}

/**
 * Full-res PNG export: cook every visible image node at full resolution
 * (one-shot, never touches the shared draft/working/baked caches — see
 * `cookNodeFullRes`), then run the *exact same* `compositeScene` routine
 * used on-screen into a full-size OffscreenCanvas, via a local-map cache
 * lookup so no node's export cook is ever backed by a lower-res cache
 * bitmap. Cancellable between node cooks; a progress toast tracks it.
 *
 * If any node's full-res cook fails, the whole export aborts with an error
 * toast — never silently substitutes a draft-level bitmap (epic acceptance).
 */
export async function exportPng(
  deps: ExportDeps = tauriExportDeps,
  onProgress?: (progress: ExportProgress) => void,
): Promise<void> {
  const scene = deps.getScene();
  const [docW, docH] = scene.documentSize;
  if (docW <= 0 || docH <= 0) {
    toast.error('Nothing to export', {
      description: 'Import an image or set a document size first.',
    });
    return;
  }

  const nodes = exportableNodes(scene);
  const cancelled = { current: false };
  const toastId = toast.loading(`Exporting 0 / ${nodes.length}`, {
    action: {
      label: 'Cancel',
      onClick: () => {
        cancelled.current = true;
      },
    },
  });

  const bitmaps = new Map<string, ImageBitmap>();
  try {
    for (let i = 0; i < nodes.length; i++) {
      if (cancelled.current) {
        toast.dismiss(toastId);
        toast('Export cancelled');
        return;
      }
      const node = nodes[i];
      toast.loading(`Exporting ${i + 1} / ${nodes.length} — ${node.label}`, { id: toastId });
      onProgress?.({ done: i, total: nodes.length });

      const bitmap = await deps.cookFullRes(node.id);
      bitmaps.set(node.id, bitmap);
    }

    if (cancelled.current) {
      toast.dismiss(toastId);
      toast('Export cancelled');
      return;
    }
    onProgress?.({ done: nodes.length, total: nodes.length });

    const canvas = deps.createCanvas(docW, docH);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

    // Local-map lookup, 'baked' level only — this is what guarantees export
    // never draws a draft/working bitmap: any level other than 'baked'
    // resolves to `undefined`, so `pickBestAvailable` has nothing to
    // cascade to (composite.ts's best-available-cache fallback never fires).
    const getCache: CacheLookup = (nodeId, level) =>
      level === 'baked' ? bitmaps.get(nodeId) : undefined;

    compositeScene(ctx, scene, 'baked', getCache);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = await deps.blobToBytes(blob);

    const path = await deps.pickSavePath(suggestedExportName(useProjectMetaStore.getState().path));
    if (!path) {
      toast.dismiss(toastId);
      return;
    }

    await deps.writeFile(path, bytes);
    toast.dismiss(toastId);
    toast.success(`Exported ${filenameOf(path)}`);
  } catch (err) {
    toast.dismiss(toastId);
    toast.error('Export failed', {
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    for (const bitmap of bitmaps.values()) {
      (bitmap as ImageBitmap & { close?: () => void }).close?.();
    }
  }
}
