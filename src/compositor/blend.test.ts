import { describe, expect, it } from 'vitest';
import type { BlendMode } from '@/scene/types';
import { mapBlendMode } from './blend';

describe('mapBlendMode', () => {
  const cases: [BlendMode, GlobalCompositeOperation][] = [
    ['normal', 'source-over'],
    ['multiply', 'multiply'],
    ['screen', 'screen'],
    ['overlay', 'overlay'],
    ['darken', 'darken'],
    ['lighten', 'lighten'],
    ['difference', 'difference'],
  ];

  for (const [mode, expected] of cases) {
    it(`maps ${mode} -> ${expected}`, () => {
      expect(mapBlendMode(mode)).toBe(expected);
    });
  }
});
