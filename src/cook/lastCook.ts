import { create } from 'zustand';

/** What the last successful cook looked like — read by the status bar (cook-time-readout.md). */
export interface LastCook {
  nodeLabel: string;
  /** The cook level, or `'baked'` for a full-resolution lock/export cook. */
  level: 'draft' | 'working' | 'baked';
  /** Wall time of the whole cook, downscale through encode. */
  totalMs: number;
  /** Sidecar round trip (including IPC and mask rasterisation), as `cookNode` measures it. */
  sidecarMs: number;
  width: number;
  height: number;
}

interface LastCookState {
  last: LastCook | null;
  publish: (cook: LastCook) => void;
}

export const useLastCookStore = create<LastCookState>((set) => ({
  last: null,
  publish: (cook) => set({ last: cook }),
}));

/** `184 ms` below one second, `1.2 s` from 1000 ms up. Whole ms; one decimal for seconds. */
export function formatCookMs(ms: number): string {
  const whole = Math.round(ms);
  if (whole >= 1000) return `${(whole / 1000).toFixed(1)} s`;
  return `${whole} ms`;
}

/** Totals at or above this tint the readout amber. */
export const SLOW_COOK_MS = 250;
