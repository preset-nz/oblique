import { invoke } from '@tauri-apps/api/core';
import type { FontFace } from './types';

/**
 * The only file that `invoke`s font commands (sanctioned second Tauri `invoke` caller
 * beside the sidecar transport; see the depcruise rule). Not frame IPC.
 */
export function listFonts(): Promise<FontFace[]> {
  return invoke<FontFace[]>('list_fonts');
}
