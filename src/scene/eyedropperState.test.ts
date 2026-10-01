import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEyedropperStore } from './eyedropperState';

describe('eyedropperState', () => {
  beforeEach(() => {
    useEyedropperStore.getState().disarm();
  });

  it('starts disarmed and arms with a field key', () => {
    expect(useEyedropperStore.getState().armed).toBeNull();
    const onPick = vi.fn();
    useEyedropperStore.getState().arm({ fieldKey: 'a', onPick });
    expect(useEyedropperStore.getState().armed?.fieldKey).toBe('a');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('pick calls back with the hex and disarms', () => {
    const onPick = vi.fn();
    useEyedropperStore.getState().arm({ fieldKey: 'a', onPick });
    useEyedropperStore.getState().pick('#aa0000');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('#aa0000');
    expect(useEyedropperStore.getState().armed).toBeNull();
  });

  it('pick while disarmed does nothing', () => {
    expect(() => useEyedropperStore.getState().pick('#000000')).not.toThrow();
    expect(useEyedropperStore.getState().armed).toBeNull();
  });

  it('re-arming replaces the previous pick', () => {
    const first = vi.fn();
    const second = vi.fn();
    useEyedropperStore.getState().arm({ fieldKey: 'a', onPick: first });
    useEyedropperStore.getState().arm({ fieldKey: 'b', onPick: second });
    expect(useEyedropperStore.getState().armed?.fieldKey).toBe('b');
    useEyedropperStore.getState().pick('#112233');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('#112233');
  });

  it('disarm cancels without calling back', () => {
    const onPick = vi.fn();
    useEyedropperStore.getState().arm({ fieldKey: 'a', onPick });
    useEyedropperStore.getState().disarm();
    expect(useEyedropperStore.getState().armed).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });
});
