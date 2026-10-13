import { notify } from '@preset.nz/ux-kit';
import { readFile } from '@tauri-apps/plugin-fs';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';

/**
 * Filename-only label — sourcePath keeps the full path; the label is
 * cosmetic (layer-panel display).
 */
export function filenameOf(path: string): string {
  const normalised = path.split('\\').join('/');
  return normalised.slice(normalised.lastIndexOf('/') + 1) || normalised;
}

/**
 * Decode + fs-read are injected so the pure ordering/defaults logic (this
 * module's job) is unit-testable without a real webview or real image
 * bytes. `tauriImportDeps` below is the one production wiring.
 */
export interface ImportDeps {
  readFile: (path: string) => Promise<Uint8Array>;
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number } & sources.Closable>;
}

async function decodeImageBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([new Uint8Array(bytes)]);
  return createImageBitmap(blob);
}

/** Production deps: real Tauri fs read + real browser decode. */
export const tauriImportDeps: ImportDeps = {
  readFile: (path) => readFile(path),
  decode: decodeImageBitmap,
};

export interface ImportOutcome {
  path: string;
  nodeId?: string;
  error?: string;
}

/**
 * Decode one file and add a pixel node for it. Never throws — decode
 * failure surfaces as a toast (filename + reason) and no node is created,
 * per the story's acceptance ("corrupt file -> toast, app healthy").
 */
export async function importFile(path: string, deps: ImportDeps): Promise<ImportOutcome> {
  const filename = filenameOf(path);
  try {
    const bytes = await deps.readFile(path);
    const bitmap = await deps.decode(bytes);

    // First pixel node imported into a truly empty/unset scene sets the
    // document size; once either a node exists OR a document size has been
    // set explicitly (document-setup dialog, roadmap "size-dialog keep
    // rule" 2026-07-05), imports keep the canvas as-is and the image comes
    // in as a node at its own sourceSize.
    const { scene, addPixelNode, setDocumentSize } = useSceneStore.getState();
    const isDocumentEmpty =
      scene.nodes.length === 0 && scene.documentSize[0] === 0 && scene.documentSize[1] === 0;
    if (isDocumentEmpty) {
      setDocumentSize([bitmap.width, bitmap.height]);
    }

    const nodeId = addPixelNode({
      sourcePath: path,
      sourceSize: [bitmap.width, bitmap.height],
      label: filename,
    });
    sources.set(nodeId, bitmap as ImageBitmap);
    sources.useSourceMissingStore.getState().clear(nodeId);
    return { path, nodeId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    notify({ message: `Couldn't import ${filename}`, kind: 'error', description: reason });
    return { path, error: reason };
  }
}

/**
 * Import files one at a time, in the given order — decode is serial by
 * design (story: "no decode races; decode serially, it's fine"). Each
 * successful import lands on top of the stack (addPixelNode's contract),
 * so the last file in `paths` ends up topmost — a deterministic function
 * of drop/selection order.
 */
export async function importFiles(paths: string[], deps: ImportDeps): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const path of paths) {
    outcomes.push(await importFile(path, deps));
  }
  return outcomes;
}
