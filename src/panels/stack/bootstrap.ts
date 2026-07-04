import { registerBuiltinRenderers } from '@preset.nz/property-editors';
import { useOpsCacheStore } from '@/sidecar/opsCache';
import { registerModifierFieldRenderers } from './modifierFieldRenderers';
import { registerModifierScopes } from './modifierScope';

/**
 * Wires up the `modifier` scope machinery: the shared package's built-in
 * renderers, Oblique's overrides (scrub-drag `InputNumber` for
 * number/slider, `ToggleGroup` for enum), and one `modifier:<opType>` scope
 * per op currently in the ops cache. Ops arrive async via `list_ops`
 * (`sidecar/opsCache.ts`), so scopes are re-registered every time the cache
 * updates — not just once at import time.
 *
 * Module-level side effect, not a `useEffect` — same rationale as
 * `cook/singleton.ts`: React 19 StrictMode double-invokes effects, which
 * would double-subscribe. Safe to import more than once (idempotent).
 */
registerBuiltinRenderers();
registerModifierFieldRenderers();
registerModifierScopes(useOpsCacheStore.getState().ops);
useOpsCacheStore.subscribe((state) => registerModifierScopes(state.ops));
