import { invoke } from '@tauri-apps/api/core';
import type { TextGeometry, TextSpec } from './textGeometry';
import type { FontFace } from './types';

/**
 * The only file that `invoke`s font commands (sanctioned second Tauri `invoke` caller
 * beside the sidecar transport; see the depcruise rule). Not frame IPC.
 */
export function listFonts(): Promise<FontFace[]> {
  return invoke<FontFace[]>('list_fonts');
}

/** Shapes `spec` in Rust and returns anchor-space glyph outlines. Rejects with the Rust error string. */
export function textOutlines(spec: TextSpec): Promise<TextGeometry> {
  return invoke<TextGeometry>('text_outlines', { spec });
}
