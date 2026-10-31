/**
 * Files a layer made in an Untitled document keeps in memory until the first Save gives them a
 * place to live (Create Depth Map, Epic 17 story 5). A pending file is named by a placeholder
 * source path, `pending://<kind>/<file>`, which is the layer's `sourcePath` until then.
 * `scene/sources.ts` decodes the bytes where a path would be read, so display, undo and redo
 * need nothing more; `project/depthFiles.ts` writes them out on save and repoints the layer.
 *
 * Module scope, outside the scene, like the source bitmaps: bytes never go in the scene object.
 *
 * Nothing is swept when a layer goes (undo of the layer, delete): redo, or undoing a later
 * Save, needs the bytes again. They are dropped only when a document is opened, which includes
 * New and closing to a new one (`project/io.ts`, `opened`).
 */

export const PENDING_SCHEME = 'pending://';

const files = new Map<string, Uint8Array>();

/** True for a placeholder path, whether or not its bytes are still held. */
export const isPendingPath = (path: string): boolean => path.startsWith(PENDING_SCHEME);

export function setPending(path: string, bytes: Uint8Array): void {
  files.set(path, bytes);
}

export function getPending(path: string): Uint8Array | undefined {
  return files.get(path);
}

/** A new document starts, or the open one is replaced: nothing from the old one is wanted. */
export function clearPending(): void {
  files.clear();
}
