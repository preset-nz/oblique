import type { DisabledWhen } from '@preset.nz/facets';
import { create } from 'zustand';

/**
 * Honest op param metadata, as returned by `list_ops` — the modifier UI
 * (Epic 04) builds param panels from this. Never hardcode a param schema
 * in TypeScript; it always comes from the op's home backend.
 */
export interface OpParamSpec {
  name: string;
  type: 'float' | 'int' | 'bool' | 'enum' | 'color';
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  scale: 'spatial' | 'none';
  choices?: string[]; // enum type only
  widget?: 'slider'; // UI hint from the op's home backend — favours the slider kind over plain number
  /** Short sentence-case panel label ("Cell size"). Presentation metadata from
   * the op's home backend; the panel falls back to `name` when absent. */
  label?: string;
  /** One plain sentence on what the param does and which way is "more",
   * shown as a hover tooltip on the label. Absent for unannotated params. */
  description?: string;
  /** Disables this param in the panel when another of the same op's params
   * matches a condition (Epic 18 story 5). Wire keys verbatim, no
   * translation layer — the type is `@preset.nz/facets`'s own, imported
   * rather than redeclared. */
  disabledWhen?: DisabledWhen;
}

export interface OpDescriptor {
  name: string;
  backend: 'python' | 'rust';
  params: OpParamSpec[];
  /** Presentation label. Always present from a current sidecar (it derives
   * one when the op's registration doesn't supply one) — optional here only
   * so an older sidecar's payload (missing the field entirely) still typechecks;
   * `opLabel` below covers that fallback at read time. */
  label?: string;
  /** One-sentence, user-facing description. Absent for ops that don't have
   * one yet (e.g. `debug_echo`, hidden from the UI anyway). */
  description?: string;
}

// Internal-name tokens that render fully upper-cased in a derived label,
// mirroring the sidecar's `ops/__init__.py::default_label` acronym set —
// keep these two lists in sync.
const ACRONYMS = new Set(['cmyk', 'dla']);

/** Derive a presentation label from a stable internal op name: snake_case
 * -> Title Case, with known acronym tokens upper-cased outright (matches
 * the sidecar's `default_label`). Used as the fallback when a descriptor
 * has no `label` (e.g. reported by an older sidecar). */
export function deriveOpLabel(name: string): string {
  return name
    .split('_')
    .map((token) =>
      ACRONYMS.has(token) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1),
    )
    .join(' ');
}

/** This descriptor's presentation label — its own `label` if the sidecar
 * sent one, otherwise derived from `name`. */
export function opLabel(descriptor: Pick<OpDescriptor, 'name' | 'label'>): string {
  return descriptor.label || deriveOpLabel(descriptor.name);
}

interface OpsCacheState {
  ops: OpDescriptor[];
  setOps: (ops: OpDescriptor[]) => void;
}

/**
 * Cache of the merged op registry (Python `list_ops` today; Rust
 * `list_rust_ops` merges in once the Rust op backend exists). Re-issued
 * every time the sidecar comes up, including after a restart.
 */
export const useOpsCacheStore = create<OpsCacheState>((set) => ({
  ops: [],
  setOps: (ops) => set({ ops }),
}));
