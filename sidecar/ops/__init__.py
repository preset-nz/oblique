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
ParamWidget = Literal["slider"]

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
    choices: tuple[str, ...] | None = None  # enum type only
    widget: ParamWidget | None = (
        None  # UI hint, e.g. "slider" over the default number field
    )

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
        if self.choices is not None:
            d["choices"] = list(self.choices)
        if self.widget is not None:
            d["widget"] = self.widget
        return d


P = ParamSpec
"""Short alias used at op-registration call sites (`P("radius", "float", ...)`)."""

# Internal-name tokens that should render fully upper-cased in a derived
# label, rather than Title-Cased (e.g. "cmyk" -> "CMYK", not "Cmyk").
_ACRONYMS = {"cmyk", "dla"}


def default_label(name: str) -> str:
    """Derive a presentation label from a stable internal op name:
    snake_case -> Title Case, with known acronym tokens upper-cased
    outright (`cmyk_halftone` -> "CMYK Halftone"). Pure and total; the
    internal `name` itself is never altered — this is presentation only.
    """
    tokens = name.split("_")
    words = [t.upper() if t in _ACRONYMS else t.capitalize() for t in tokens]
    return " ".join(words)


@dataclass(frozen=True)
class Op:
    name: str
    backend: Literal["python"]
    params: list[ParamSpec]
    fn: OpFn
    label: str = ""
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": self.name,
            "backend": self.backend,
            "params": [p.to_dict() for p in self.params],
            "label": self.label or default_label(self.name),
        }
        if self.description:
            d["description"] = self.description
        return d


OPS: dict[str, Op] = {}


def op(
    name: str,
    params: list[ParamSpec] | None = None,
    *,
    label: str = "",
    description: str = "",
) -> Callable[[OpFn], OpFn]:
    """Decorator; registers a pure fn (RGBA8 ndarray, params dict) -> RGBA8 ndarray.

    `label`/`description` are presentation-only metadata surfaced through
    `list_ops` — the stable identifier for scene files, scope keys and
    dispatch stays `name`, always. When `label` is omitted, one is derived
    from `name` at serialisation time (see `default_label`).
    """

    def decorator(fn: OpFn) -> OpFn:
        OPS[name] = Op(
            name=name,
            backend="python",
            params=params or [],
            fn=fn,
            label=label,
            description=description,
        )
        return fn

    return decorator


@op("debug_echo")
def debug_echo(payload: bytes, params: dict[str, Any]) -> bytes:
    """Identity op — returns the payload unchanged. The protocol's canary."""
    return payload


# Imported for registration side effect only — each module calls `@op(...)`
# at import time. Keep at the bottom so `OPS`/`op`/`P` exist first.
from ops import cmyk_halftone as _cmyk_halftone  # noqa: E402, F401
from ops import colour_crush as _colour_crush  # noqa: E402, F401
from ops import gaussian_blur as _gaussian_blur  # noqa: E402, F401
from ops import grain as _grain  # noqa: E402, F401
from ops import ink_starved as _ink_starved  # noqa: E402, F401
from ops import invert as _invert  # noqa: E402, F401
from ops import levels as _levels  # noqa: E402, F401
from ops import threshold as _threshold  # noqa: E402, F401
from ops import xerox as _xerox  # noqa: E402, F401
