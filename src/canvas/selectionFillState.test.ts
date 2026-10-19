import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionFillStore } from './selectionFillState';

beforeEach(() => useSelectionFillStore.setState({ enabled: true }));

describe('selection fill toggle store (selection-fill-overlay.md)', () => {
  it('starts on', () => {
    expect(useSelectionFillStore.getInitialState().enabled).toBe(true);
  });

  it('setEnabled flips it off and on', () => {
    useSelectionFillStore.getState().setEnabled(false);
    expect(useSelectionFillStore.getState().enabled).toBe(false);
    useSelectionFillStore.getState().setEnabled(true);
    expect(useSelectionFillStore.getState().enabled).toBe(true);
  });
});
