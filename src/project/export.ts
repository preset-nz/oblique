import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import {
  type CacheLookup,
  type Composite2DContext,
  type CreateScratch,
  compositeScene,
} from '@/compositor/composite';
import { cookNodeFullRes } from '@/cook/cook';
import * as cache from '@/scene/cache';
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
  /**
   * The shared `baked` cache slot (lock-state-machine.md) — locking makes
   * export cheaper: a locked node's frozen bitmap is reused as-is instead of
   * cooking it again. `undefined` (not yet rehydrated) falls back to
   * `cookFullRes`, same as an active node.
   */
  getBaked: (nodeId: string) => ImageBitmap | undefined;
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
  getBaked: (nodeId) => cache.get(nodeId, 'baked'),
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

/**
 * Visible nodes — export must cook mask-output nodes too, or the compositor
 * has no clip bitmap and masked spans vanish from the PNG
 * (mask-span-scoping.md). Mask nodes are never *drawn* as content; the
 * span walk only reads their raster for `destination-in`.
 */
export function exportableNodes(scene: Scene) {
  return scene.nodes.filter((n) => n.visible);
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

  // Ask for the destination up front — committing to a long cook before the
  // user has even confirmed the export reads as "nothing happened".
  const path = await deps.pickSavePath(suggestedExportName(useProjectMetaStore.getState().path));
  if (!path) return;

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
  // One-shot cooks only — never the shared `baked` cache bitmap reused below
  // for locked nodes, which must survive this export (still the live cache
  // entry future paints/exports read).
  const ownedBitmaps = new Set<string>();
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

      // Locking makes export cheaper (lock-state-machine.md): a locked
      // node's frozen bake is reused as-is instead of recooking it.
      const baked = node.state === 'locked' ? deps.getBaked(node.id) : undefined;
      if (baked) {
        bitmaps.set(node.id, baked);
      } else {
        const bitmap = await deps.cookFullRes(node.id);
        bitmaps.set(node.id, bitmap);
        ownedBitmaps.add(node.id);
      }
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

    // Masked spans composite into scratch canvases; build them from the same
    // injected canvas factory as the main surface (the real ExportCanvas is
    // an OffscreenCanvas, which drawImage accepts as a source).
    const createScratch: CreateScratch = (w, h) => {
      const scratchCanvas = deps.createCanvas(Math.max(1, w), Math.max(1, h));
      const scratchCtx = scratchCanvas.getContext('2d');
      if (!scratchCtx) throw new Error('OffscreenCanvas 2d context unavailable');
      return { ctx: scratchCtx, canvas: scratchCanvas as unknown as CanvasImageSource };
    };

    compositeScene(ctx, scene, 'baked', getCache, createScratch);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = await deps.blobToBytes(blob);

    await deps.writeFile(path, bytes);
    toast.dismiss(toastId);
    toast.success(`Exported ${filenameOf(path)}`);
  } catch (err) {
    toast.dismiss(toastId);
    toast.error('Export failed', {
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    for (const [nodeId, bitmap] of bitmaps) {
      if (!ownedBitmaps.has(nodeId)) continue; // shared baked cache bitmap — never close
      (bitmap as ImageBitmap & { close?: () => void }).close?.();
    }
  }
}
