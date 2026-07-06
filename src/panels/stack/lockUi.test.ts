import { describe, expect, it } from 'vitest';
import {
  isNodeBaking,
  isNodeLocked,
  padlockAriaLabel,
  padlockClickIgnored,
  padlockVisualState,
  stackControlsDisabled,
} from './lockUi';

describe('isNodeLocked', () => {
  it('true only for state === locked', () => {
    expect(isNodeLocked({ state: 'locked' })).toBe(true);
    expect(isNodeLocked({ state: 'active' })).toBe(false);
  });
});

describe('isNodeBaking', () => {
  it('reflects bakingNodeIds membership', () => {
    const baking = new Set(['a']);
    expect(isNodeBaking('a', baking)).toBe(true);
    expect(isNodeBaking('b', baking)).toBe(false);
  });
});

describe('padlockVisualState', () => {
  it('baking wins over the node state', () => {
    expect(padlockVisualState({ state: 'active' }, 'a', new Set(['a']))).toBe('baking');
    expect(padlockVisualState({ state: 'locked' }, 'a', new Set(['a']))).toBe('baking');
  });

  it('falls back to locked/active once baking clears', () => {
    expect(padlockVisualState({ state: 'locked' }, 'a', new Set())).toBe('locked');
    expect(padlockVisualState({ state: 'active' }, 'a', new Set())).toBe('active');
  });
});

describe('padlockClickIgnored', () => {
  it('ignores clicks mid-bake only', () => {
    expect(padlockClickIgnored('a', new Set(['a']))).toBe(true);
    expect(padlockClickIgnored('a', new Set())).toBe(false);
  });
});

describe('padlockAriaLabel', () => {
  it('describes the action a click would take', () => {
    expect(padlockAriaLabel('active')).toBe('Lock layer');
    expect(padlockAriaLabel('locked')).toBe('Unlock layer');
    expect(padlockAriaLabel('baking')).toBe('Baking…');
  });
});

describe('stackControlsDisabled', () => {
  it('mirrors isNodeLocked', () => {
    expect(stackControlsDisabled({ state: 'locked' })).toBe(true);
    expect(stackControlsDisabled({ state: 'active' })).toBe(false);
  });
});
