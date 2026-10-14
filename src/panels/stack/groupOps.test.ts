import { describe, expect, it } from 'vitest';
import type { OpCategory, OpDescriptor } from '@/sidecar/opsCache';
import { groupOpsByCategory } from './groupOps';

const op = (name: string, category?: string): OpDescriptor => ({
  name,
  backend: 'python',
  params: [],
  ...(category ? { category } : {}),
});

// Declared order is deliberately not alphabetical, to prove the sidecar's order wins.
const categories: OpCategory[] = [
  { id: 'film', label: 'Film' },
  { id: 'colour', label: 'Colour' },
  { id: 'edges', label: 'Edges' },
];

describe('groupOpsByCategory', () => {
  it('orders groups as the sidecar declares them, keeping op order inside each', () => {
    const groups = groupOpsByCategory(
      [op('invert', 'colour'), op('grain', 'film'), op('levels', 'colour'), op('bloom', 'film')],
      categories,
    );
    expect(groups.map((g) => [g.label, g.ops.map((o) => o.name)])).toEqual([
      ['Film', ['grain', 'bloom']],
      ['Colour', ['invert', 'levels']],
    ]);
  });

  it('drops categories with no ops', () => {
    const groups = groupOpsByCategory([op('grain', 'film')], categories);
    expect(groups.map((g) => g.id)).toEqual(['film']);
  });

  it('puts uncategorised and unlisted-category ops last, under Other', () => {
    const groups = groupOpsByCategory(
      [op('mystery'), op('grain', 'film'), op('odd', 'not_a_category')],
      categories,
    );
    expect(groups.map((g) => g.label)).toEqual(['Film', 'Other']);
    expect(groups[1].id).toBeNull();
    expect(groups[1].ops.map((o) => o.name)).toEqual(['mystery', 'odd']);
  });

  it('puts everything under Other when the sidecar sent no category list', () => {
    const groups = groupOpsByCategory([op('invert', 'colour')], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: null, label: 'Other' });
  });

  it('returns nothing for no ops', () => {
    expect(groupOpsByCategory([], categories)).toEqual([]);
  });
});
