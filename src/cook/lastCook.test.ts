import { beforeEach, describe, expect, it } from 'vitest';
import { formatCookMs, useLastCookStore } from './lastCook';

describe('formatCookMs', () => {
  it.each([
    [0, '0 ms'],
    [184, '184 ms'],
    [183.6, '184 ms'],
    [999, '999 ms'],
    [1000, '1.0 s'],
    [12345, '12.3 s'],
  ])('%d -> %s', (ms, expected) => {
    expect(formatCookMs(ms)).toBe(expected);
  });
});

describe('useLastCookStore', () => {
  beforeEach(() => useLastCookStore.setState({ last: null }));

  it('starts empty and holds the latest published cook', () => {
    expect(useLastCookStore.getState().last).toBeNull();
    const cook = {
      nodeLabel: 'Layer',
      level: 'draft' as const,
      totalMs: 12,
      sidecarMs: 8,
      width: 100,
      height: 50,
    };
    useLastCookStore.getState().publish(cook);
    expect(useLastCookStore.getState().last).toEqual(cook);
  });
});
