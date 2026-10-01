import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAll,
  clearNode,
  getLastStack,
  getPrefix,
  heldNodeIds,
  PREFIX_NODE_CAP,
  type PrefixEntry,
  setLastStack,
  setPrefix,
} from './prefixStore';

function entry(tag: string): PrefixEntry {
  return {
    descriptor: { source: tag, width: 1, height: 1, modifiers: [tag] },
    bytes: new Uint8Array(4),
  };
}

beforeEach(() => clearAll());

describe('prefixStore', () => {
  it('round-trips an entry per node and level, independently', () => {
    const d = entry('draft');
    const w = entry('working');
    setPrefix('a', 'draft', d);
    setPrefix('a', 'working', w);
    expect(getPrefix('a', 'draft')).toBe(d);
    expect(getPrefix('a', 'working')).toBe(w);
    expect(getPrefix('b', 'draft')).toBeUndefined();
  });

  it('keeps the last stack per level and replaces on write', () => {
    setLastStack('a', 'draft', ['x']);
    setLastStack('a', 'working', ['y']);
    setLastStack('a', 'draft', ['z']);
    expect(getLastStack('a', 'draft')).toEqual(['z']);
    expect(getLastStack('a', 'working')).toEqual(['y']);
  });

  it('caps at two nodes: a third evicts the least recently used of the first two', () => {
    expect(PREFIX_NODE_CAP).toBe(2);
    setPrefix('a', 'draft', entry('a'));
    setPrefix('b', 'draft', entry('b'));
    setPrefix('c', 'draft', entry('c'));
    expect(heldNodeIds()).toEqual(['b', 'c']);
    expect(getPrefix('a', 'draft')).toBeUndefined();
    expect(getLastStack('a', 'draft')).toBeUndefined();
  });

  it('a read hit counts as use: reading A makes B the eviction victim', () => {
    setPrefix('a', 'draft', entry('a'));
    setPrefix('b', 'draft', entry('b'));
    expect(getPrefix('a', 'draft')).toBeDefined(); // a is now most recent
    setPrefix('c', 'draft', entry('c'));
    expect(getPrefix('b', 'draft')).toBeUndefined();
    expect(getPrefix('a', 'draft')).toBeDefined();
    expect(getPrefix('c', 'draft')).toBeDefined();
  });

  it('reading a node with no state does not claim a slot', () => {
    setPrefix('a', 'draft', entry('a'));
    setPrefix('b', 'draft', entry('b'));
    expect(getPrefix('ghost', 'draft')).toBeUndefined();
    expect(heldNodeIds()).toEqual(['a', 'b']);
  });

  it('clearNode drops one node, clearAll drops everything', () => {
    setPrefix('a', 'draft', entry('a'));
    setLastStack('b', 'draft', ['b']);
    clearNode('a');
    expect(getPrefix('a', 'draft')).toBeUndefined();
    expect(getLastStack('b', 'draft')).toEqual(['b']);
    clearAll();
    expect(getLastStack('b', 'draft')).toBeUndefined();
    expect(heldNodeIds()).toEqual([]);
  });
});
