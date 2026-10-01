import type { VectorPath } from '../scene/types';

/**
 * Mirrors of the Rust text engine's IPC types (src-tauri/src/text/mod.rs). Types only.
 * `TextGeometry.paths` are in anchor space: the origin is the align anchor on the first
 * line's baseline, y points down, units are document px (Epic 20 layout contract).
 */
export interface TextSpec {
  content: string;
  postscriptName: string;
  fontSize: number;
  tracking: number;
  kerning: boolean;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
}

export interface TextGeometry {
  paths: VectorPath[];
  lines: { xStart: number; width: number; baselineY: number }[];
  ascent: number;
  descent: number;
  bounds: { x: number; y: number; w: number; h: number } | null;
}
