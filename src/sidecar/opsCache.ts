import { create } from 'zustand';

/**
 * Honest op param metadata, as returned by `list_ops` — the modifier UI
 * (Epic 04) builds param panels from this. Never hardcode a param schema
 * in TypeScript; it always comes from the op's home backend.
 */
export interface OpParamSpec {
  name: string;
  type: 'float' | 'int' | 'bool' | 'enum';
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  scale: 'spatial' | 'none';
  choices?: string[]; // enum type only
}

export interface OpDescriptor {
  name: string;
  backend: 'python' | 'rust';
  params: OpParamSpec[];
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
