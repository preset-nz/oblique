import type { BlendMode } from '@/scene/types';

/**
 * BlendMode -> GlobalCompositeOperation, per design/architecture.md
 * §Compositor. `BlendMode` is deliberately the small subset of
 * `GlobalCompositeOperation` values we expose in the UI — one mapping
 * table, no shader work.
 */
const BLEND_MODE_TABLE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  difference: 'difference',
};

export function mapBlendMode(mode: BlendMode): GlobalCompositeOperation {
  return BLEND_MODE_TABLE[mode];
}
