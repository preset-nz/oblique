"""Op registry.

Every op is a pure function registered with the `@op` decorator. The
registry is the sidecar's only extension point for image ops — Rust never
hardcodes param schemas, it reads them from `list_ops` (see
guidance/projects/oblique/design/architecture.md Section "Op backends").

`debug_echo` is the protocol's permanent round-trip canary (kept forever,
alongside its Rust-side twin) — it is intentionally the only op registered
by this story; the real image ops land in Epic 02.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

ParamScale = Literal["spatial", "none"]
ParamType = Literal["float", "int", "bool", "enum"]

OpFn = Callable[[bytes, dict[str, Any]], bytes]


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
    """Decorator; registers a pure fn (payload bytes, params dict) -> payload bytes."""

    def decorator(fn: OpFn) -> OpFn:
        OPS[name] = Op(name=name, backend="python", params=params or [], fn=fn)
        return fn

    return decorator


@op("debug_echo")
def debug_echo(payload: bytes, params: dict[str, Any]) -> bytes:
    """Identity op — returns the payload unchanged. The protocol's canary."""
    return payload
