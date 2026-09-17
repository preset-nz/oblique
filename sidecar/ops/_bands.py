"""Row-band thread parallelism (epic 18, story 8) for ops whose per-pixel
maths, once each layer/band has arranged its own reads so a band only
needs what it is given, is a pure function of the pixel's own row and any
shared, read-only, whole-image input (e.g. `hatch`'s tone map `t`, read
for cell-centre lookups that may land outside the band's own rows).

**Opt-in per op, not a cook-level split.** A generic row split over every
op would silently break any op that reads neighbouring pixels across a
band boundary (blur, dilate, erode, pixelate, halftone, `hatch`'s own
cell-centre tone lookup). `map_rows` is a tool an op reaches for once it
has arranged its own reads so a band's output depends only on its own
rows plus whatever whole, read-only input it was handed — never on rows
computed by another band.

NumPy releases the GIL inside its ufuncs, so a `ThreadPoolExecutor` over
horizontal bands parallelises elementwise work with no extra process, no
pickling, and no new dependency.
"""

from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import numpy as np

_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()


# Default thread cap for `map_rows` (epic 18, story 9 doc, "Why"). Measured
# on `hatch`'s worst-case config (crosses, jitter 0.5, 2048^2, an 18-core
# M5 Pro): 2.11s at 1 thread, 0.53s at 8, 0.54s at 12, 0.59s at 18 — scaling
# stops at 8 because ~1 MB per-band arrays stream from DRAM (128 KB arrays
# scale 5.6x at 8 threads where 1 MB arrays scale 3.1x) and more threads
# past that just add GIL hand-off overhead for no further bandwidth. The
# env var still overrides for machines or ops where that trade-off differs.
_DEFAULT_MAX_WORKERS = 8


def worker_count() -> int:
    """Thread count for `map_rows`. Reads `OBLIQUE_SIDECAR_THREADS` fresh on
    every call (never cached) so a test can force single-threaded execution
    by monkeypatching this function or setting the env var mid-process;
    falls back to `min(os.cpu_count() or 1, _DEFAULT_MAX_WORKERS)`. A
    non-positive or unparseable env value is ignored, same fallback."""
    raw = os.environ.get("OBLIQUE_SIDECAR_THREADS")
    if raw:
        try:
            n = int(raw)
        except ValueError:
            n = 0
        if n > 0:
            return n
    return min(os.cpu_count() or 1, _DEFAULT_MAX_WORKERS)


def _get_executor() -> ThreadPoolExecutor:
    """One module-level executor, created lazily and sized at `os.cpu_count()`
    — independent of `worker_count()`, so a test that monkeypatches
    `worker_count` to change the *band count* doesn't also shrink the pool
    that runs them."""
    global _executor
    if _executor is None:
        with _executor_lock:
            if _executor is None:
                _executor = ThreadPoolExecutor(max_workers=os.cpu_count() or 1)
    return _executor


def map_rows(
    height: int, fn: Callable[[int, int], np.ndarray], *, min_rows: int = 128
) -> np.ndarray:
    """Split `[0, height)` into `n = min(worker_count(), ceil(height /
    min_rows))` contiguous row bands, run `fn(y0, y1)` for each on the
    shared thread pool, and `np.concatenate` the returned `(y1 - y0, ...)`
    arrays back into row order. With one worker, or `height < 2 *
    min_rows`, calls `fn(0, height)` directly on the calling thread —
    no executor, no thread-pool overhead for images too small to benefit.
    A band that raises propagates its exception to the caller (`.result()`
    is never swallowed)."""
    bands = -(-height // min_rows)  # ceil(height / min_rows)
    n = min(worker_count(), bands)

    if n <= 1 or height < 2 * min_rows:
        return fn(0, height)

    bounds = [(i * height // n, (i + 1) * height // n) for i in range(n)]
    executor = _get_executor()
    futures = [executor.submit(fn, y0, y1) for y0, y1 in bounds]
    results = [future.result() for future in futures]
    return np.concatenate(results, axis=0)
