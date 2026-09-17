"""Shim over the native `oblique_kernels` extension (Epic 19, architecture
decision 11a — see guidance/projects/oblique/design/architecture.md §"Native
kernels inside the Python backend").

Kernel-backed ops import this module and call `require()` to get the
extension, falling back to their NumPy reference implementation only when
`available()` is `False` — and a test in `just check` fails whenever that
fallback is live, so it never ships silently.

The import happens once, here, at module load. `available()` re-reads the
`OBLIQUE_KERNELS` env var on every call (rather than caching it) so tests can
flip it mid-run without reimporting.
"""

from __future__ import annotations

import os
from types import ModuleType

try:
    import oblique_kernels as _oblique_kernels

    _import_error: str | None = None
except ImportError as exc:
    _oblique_kernels = None
    _import_error = str(exc)


def available() -> bool:
    """True when the extension imported cleanly and `OBLIQUE_KERNELS` hasn't
    disabled it (`OBLIQUE_KERNELS=0`, set by A/B runs and tests)."""
    if _oblique_kernels is None:
        return False
    return os.environ.get("OBLIQUE_KERNELS", "1") != "0"


def require() -> ModuleType:
    """The imported `oblique_kernels` module, or raise with the original
    import error text. Callers that already checked `available()` use this
    to get the module; it does not itself consult `OBLIQUE_KERNELS`."""
    if _oblique_kernels is None:
        raise ImportError(f"oblique_kernels is not available: {_import_error}")
    return _oblique_kernels
