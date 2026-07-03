"""Op registry.

Every op is a pure function registered with the `@op` decorator: `(img:
np.ndarray RGBA8, params: dict) -> np.ndarray RGBA8`, same shape in/out,
must not mutate `img`. The registry is the sidecar's only extension point
for image ops — the UI never hardcodes param schemas, it reads them from
`list_ops` (see guidance/projects/oblique/design/architecture.md Section
"Op backends"). Individual op implementations live in sibling modules
(`ops/gaussian_blur.py` etc.) and are imported at the bottom of this file
purely for their registration side effect.

`debug_echo` is the protocol's permanent round-trip canary (kept forever,
alongside its Rust-side twin).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

ParamScale = Literal["spatial", "none"]
ParamType = Literal["float", "int", "bool", "enum"]

# Pure fn (RGBA8 ndarray, params dict) -> RGBA8 ndarray, same shape, uint8 in/out,
# must not mutate its input. `debug_echo` is the exception grandfathered from
# Epic 01 (identity is type-agnostic, so it also works when handed raw bytes by
# the generic single-op dispatch path in main.py).
OpFn = Callable[[Any, dict[str, Any]], Any]


@dataclass(frozen=True)
class ParamSpec:
    """Honest param metadata — the UI builds panels from this, never hardcoded."""

    name: str
    type: ParamType
    default: Any
    min: float | None = None
    max: float | None = None
    step: float | None = None
    scale: ParamScale = "none"

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": self.name,
            "type": self.type,
            "default": self.default,
            "scale": self.scale,
        }
        if self.min is not None:
            d["min"] = self.min
        if self.max is not None:
            d["max"] = self.max
        if self.step is not None:
            d["step"] = self.step
        return d


P = ParamSpec
"""Short alias used at op-registration call sites (`P("radius", "float", ...)`)."""


@dataclass(frozen=True)
class Op:
    name: str
    backend: Literal["python"]
    params: list[ParamSpec]
    fn: OpFn

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "backend": self.backend,
            "params": [p.to_dict() for p in self.params],
        }


OPS: dict[str, Op] = {}


def op(name: str, params: list[ParamSpec] | None = None) -> Callable[[OpFn], OpFn]:
    """Decorator; registers a pure fn (RGBA8 ndarray, params dict) -> RGBA8 ndarray."""

    def decorator(fn: OpFn) -> OpFn:
        OPS[name] = Op(name=name, backend="python", params=params or [], fn=fn)
        return fn

    return decorator


@op("debug_echo")
def debug_echo(payload: bytes, params: dict[str, Any]) -> bytes:
    """Identity op — returns the payload unchanged. The protocol's canary."""
    return payload


# Imported for registration side effect only — each module calls `@op(...)`
# at import time. Keep at the bottom so `OPS`/`op`/`P` exist first.
from ops import gaussian_blur as _gaussian_blur  # noqa: E402, F401
from ops import grain as _grain  # noqa: E402, F401
from ops import invert as _invert  # noqa: E402, F401
from ops import levels as _levels  # noqa: E402, F401
from ops import threshold as _threshold  # noqa: E402, F401
