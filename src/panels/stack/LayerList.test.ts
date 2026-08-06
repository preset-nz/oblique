import { describe, expect, it } from 'vitest';
import { commitLabel, fitContain, nudgeIndex } from './LayerList';

describe('fitContain', () => {
  it('centres a square bitmap exactly filling the box', () => {
    expect(fitContain(100, 100, 40)).toEqual({ x: 0, y: 0, w: 40, h: 40 });
  });

  it('letterboxes a wide bitmap (width-constrained)', () => {
    const { x, y, w, h } = fitContain(200, 100, 40);
    expect(w).toBe(40);
    expect(h).toBe(20);
    expect(x).toBe(0);
    expect(y).toBe(10);
  });

  it('pillarboxes a tall bitmap (height-constrained)', () => {
    const { x, y, w, h } = fitContain(100, 200, 40);
    expect(h).toBe(40);
    expect(w).toBe(20);
    expect(y).toBe(0);
    expect(x).toBe(10);
  });

  it('returns a zero rect for degenerate input', () => {
    expect(fitContain(0, 100, 40)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(fitContain(100, 0, 40)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('nudgeIndex', () => {
  it('moves up within bounds', () => {
    expect(nudgeIndex(1, 'up', 3)).toBe(0);
  });

  it('moves down within bounds', () => {
    expect(nudgeIndex(1, 'down', 3)).toBe(2);
  });

  it('returns null moving up from the top row', () => {
    expect(nudgeIndex(0, 'up', 3)).toBeNull();
  });

  it('returns null moving down from the bottom row', () => {
    expect(nudgeIndex(2, 'down', 3)).toBeNull();
  });

  it('returns null for a single-row list in either direction', () => {
    expect(nudgeIndex(0, 'up', 1)).toBeNull();
    expect(nudgeIndex(0, 'down', 1)).toBeNull();
  });
});

describe('commitLabel', () => {
  it('returns the new label when it differs', () => {
    expect(commitLabel('Sky', 'IMG_4821.png')).toBe('Sky');
  });

  it('trims surrounding whitespace', () => {
    expect(commitLabel('  Sky  ', 'IMG_4821.png')).toBe('Sky');
  });

  it('is a no-op when the trimmed draft equals the current label', () => {
    expect(commitLabel('Sky', 'Sky')).toBeNull();
    expect(commitLabel('  Sky  ', 'Sky')).toBeNull();
  });

  it('is a no-op for an empty or whitespace-only draft', () => {
    expect(commitLabel('', 'Sky')).toBeNull();
    expect(commitLabel('   ', 'Sky')).toBeNull();
    expect(commitLabel('\t\n', 'Sky')).toBeNull();
  });

  it('keeps interior whitespace and punctuation (Draw Things prompts stay renameable to anything)', () => {
    expect(commitLabel('  grim-dark cave, mushrooms  ', 'x')).toBe('grim-dark cave, mushrooms');
  });
});
