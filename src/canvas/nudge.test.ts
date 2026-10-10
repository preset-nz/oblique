import { describe, expect, it } from 'vitest';
import { nudgeDirection } from './nudge';

const none = { altKey: false, metaKey: false, ctrlKey: false };

describe('nudgeDirection', () => {
  it('maps the bare arrows to a document-space step', () => {
    expect(nudgeDirection({ key: 'ArrowUp', ...none })).toEqual([0, -1]);
    expect(nudgeDirection({ key: 'ArrowDown', ...none })).toEqual([0, 1]);
    expect(nudgeDirection({ key: 'ArrowLeft', ...none })).toEqual([-1, 0]);
    expect(nudgeDirection({ key: 'ArrowRight', ...none })).toEqual([1, 0]);
  });

  it('ignores other keys', () => {
    expect(nudgeDirection({ key: 'a', ...none })).toBeNull();
  });

  it('does not nudge on Opt+arrow, which is Bring Forward and Send Backward', () => {
    expect(nudgeDirection({ key: 'ArrowUp', ...none, altKey: true })).toBeNull();
    expect(nudgeDirection({ key: 'ArrowDown', ...none, altKey: true })).toBeNull();
  });

  it('does not nudge on Cmd or Ctrl with an arrow', () => {
    expect(nudgeDirection({ key: 'ArrowLeft', ...none, metaKey: true })).toBeNull();
    expect(nudgeDirection({ key: 'ArrowLeft', ...none, ctrlKey: true })).toBeNull();
  });
});
