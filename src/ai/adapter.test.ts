import { describe, expect, it } from 'vitest';
import {
  type AiAdapter,
  canCaption,
  canGenerate,
  canInpaint,
  canOutpaint,
  canRemoveBackground,
  canSegment,
  canUpscale,
} from './adapter';

function driverWith(capabilities: AiAdapter['capabilities']): AiAdapter {
  return {
    capabilities,
    health: async () => ({ ok: true, detail: 'Connected' }),
  };
}

describe('capability gating', () => {
  it('a driver without inpaint makes canInpaint() false', () => {
    const driver = driverWith(new Set(['segment']));
    expect(canInpaint(driver)).toBe(false);
    expect(canSegment(driver)).toBe(true);
  });

  it('a driver with inpaint makes canInpaint() true', () => {
    const driver = driverWith(new Set(['inpaint']));
    expect(canInpaint(driver)).toBe(true);
  });

  it('a driver with no capabilities gates every task off', () => {
    const driver = driverWith(new Set());
    expect(canGenerate(driver)).toBe(false);
    expect(canInpaint(driver)).toBe(false);
    expect(canOutpaint(driver)).toBe(false);
    expect(canUpscale(driver)).toBe(false);
    expect(canSegment(driver)).toBe(false);
    expect(canCaption(driver)).toBe(false);
    expect(canRemoveBackground(driver)).toBe(false);
  });
});
