import { cookNode } from './cook';
import { CookScheduler } from './scheduler';

/**
 * App-wide cook scheduler instance. A module-level singleton (not a
 * `useEffect`) for the same reason as `sidecar/singleton.ts` — React 19
 * StrictMode's double-invoked effects can't register duplicate store
 * subscriptions.
 */
export const cookScheduler = new CookScheduler(cookNode);
cookScheduler.start();
