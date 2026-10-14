import type { OpCategory, OpDescriptor } from '@/sidecar/opsCache';

export interface OpGroup {
  /** The category id, or `null` for the trailing "Other" group. */
  id: string | null;
  label: string;
  ops: OpDescriptor[];
}

/** Heading for ops that have no category (or one the sidecar doesn't list). */
export const OTHER_LABEL = 'Other';

/**
 * Groups ops for the Add modifier picker: one group per category in the
 * order the sidecar declares them, then "Other" last for ops with no (or an
 * unlisted) category. Empty groups are dropped, so a search that matches
 * nothing in a category hides its heading. Op order inside a group is the
 * order given. Pure: the categories, their order and their headings all
 * come from the sidecar, never from here.
 */
export function groupOpsByCategory(ops: OpDescriptor[], categories: OpCategory[]): OpGroup[] {
  const known = new Set(categories.map((c) => c.id));
  const groups: OpGroup[] = categories.map((c) => ({
    id: c.id,
    label: c.label,
    ops: ops.filter((op) => op.category === c.id),
  }));
  const other = ops.filter((op) => !op.category || !known.has(op.category));
  groups.push({ id: null, label: OTHER_LABEL, ops: other });
  return groups.filter((g) => g.ops.length > 0);
}
