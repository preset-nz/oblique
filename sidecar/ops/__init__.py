"""Op registry.

Every op is a pure function registered with the `@op` decorator: `(img:
np.ndarray RGBA8, params: dict) -> np.ndarray RGBA8`, same shape in/out,
must not mutate `img`. By default it also leaves alpha untouched; an op
that must write into or erase transparency declares `writes_alpha=True`
and is held to every other clause unchanged. The registry is the
sidecar's only extension point for image ops — the UI never hardcodes param schemas, it reads them from
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
ParamType = Literal["float", "int", "bool", "enum", "color"]
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
    # Disables this param in the panel when another of the same op's params
    # matches a condition — presentation only, the cook still receives and
    # ignores the value. Wire keys verbatim (`path`, plus exactly one of
    # `equals`/`notEquals`/`in`/`notIn`), so `to_dict` can emit it straight
    # through as `disabledWhen` with no translation layer. Validated at
    # registration — see `_validate_disabled_when`.
    disabled_when: dict[str, Any] | None = None

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
        if self.disabled_when is not None:
            # Fresh dict, not a reference to `self.disabled_when` — a caller
            # holding the wire payload must not be able to mutate the spec
            # — with `in`/`notIn` values coerced to JSON-serialisable lists
            # (the annotation itself may hold a tuple).
            d["disabledWhen"] = {
                key: (list(value) if key in ("in", "notIn") else value)
                for key, value in self.disabled_when.items()
            }
        return d


P = ParamSpec
"""Short alias used at op-registration call sites (`P("radius", "float", ...)`)."""


# Rec. 709 luma weights — the one definition of "what grey means" shared by
# every op that needs it (`xerox`'s mono conversion, `desaturate`'s amount=1
# greyscale). Lifted here rather than duplicated per-op so they can't drift.
LUMA_R709, LUMA_G709, LUMA_B709 = 0.2126, 0.7152, 0.0722


_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


def hex_to_rgb01(
    value: Any, fallback: tuple[float, float, float]
) -> tuple[float, float, float]:
    """Parse a `color`-typed param value into `(r, g, b)` floats in `[0, 1]`.

    Accepts `#rrggbb`, `#rgb`, and the same without the leading `#`,
    case-insensitive, with surrounding whitespace tolerated. Alpha
    (`#rrggbbaa`) is not accepted — colour params are opaque in this epic.

    Total: never raises. Any other input — `None`, a number, a wrong-length
    string, non-hex digits — returns `fallback` unchanged. Ops are pure and
    must survive a hand-edited `.oblique` with a garbage colour string
    without failing the cook.
    """
    if not isinstance(value, str):
        return fallback

    s = value.strip().removeprefix("#")

    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)

    # Restricted to plain ASCII hex digits before parsing — `int(x, 16)`
    # alone would also accept a leading sign, underscores, or unicode
    # digits (e.g. "-1-2-3" is 6 chars and parses to negative floats),
    # which would silently break the documented [0, 1] range.
    if len(s) != 6 or not all(ch in _HEX_DIGITS for ch in s):
        return fallback

    r = int(s[0:2], 16)
    g = int(s[2:4], 16)
    b = int(s[4:6], 16)

    return (r / 255.0, g / 255.0, b / 255.0)


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
    writes_alpha: bool = False

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": self.name,
            "backend": self.backend,
            "params": [p.to_dict() for p in self.params],
            "label": self.label or default_label(self.name),
            "writes_alpha": self.writes_alpha,
        }
        if self.description:
            d["description"] = self.description
        return d


OPS: dict[str, Op] = {}

_DISABLED_WHEN_OPERATORS = ("equals", "notEquals", "in", "notIn")


def _validate_disabled_when(
    op_name: str, spec: ParamSpec, params_by_name: dict[str, ParamSpec]
) -> None:
    """Validates one param's `disabled_when` at registration time, so a typo
    fails at import rather than silently in the UI (story 5 doc,
    "Validate at registration")."""
    cond = spec.disabled_when
    if cond is None:
        return

    path = cond.get("path")
    if not isinstance(path, str) or path == spec.name or path not in params_by_name:
        raise ValueError(
            f"{op_name}.{spec.name}: disabled_when path {path!r} must name "
            "another param of the same op"
        )

    unknown_keys = set(cond) - {"path", *_DISABLED_WHEN_OPERATORS}
    if unknown_keys:
        raise ValueError(
            f"{op_name}.{spec.name}: disabled_when has unknown key(s) "
            f"{sorted(unknown_keys)}"
        )

    operator_keys = [key for key in _DISABLED_WHEN_OPERATORS if key in cond]
    if len(operator_keys) != 1:
        raise ValueError(
            f"{op_name}.{spec.name}: disabled_when must set exactly one of "
            f"{_DISABLED_WHEN_OPERATORS}, got {operator_keys}"
        )
    operator = operator_keys[0]
    operand = cond[operator]

    if operator in ("in", "notIn"):
        if not isinstance(operand, (list, tuple)) or len(operand) == 0:
            raise ValueError(
                f"{op_name}.{spec.name}: disabled_when.{operator} must be a "
                "non-empty list/tuple"
            )
        values = list(operand)
    else:
        values = [operand]

    referenced = params_by_name[path]
    if referenced.type == "enum" and referenced.choices is not None:
        bad = [value for value in values if value not in referenced.choices]
        if bad:
            raise ValueError(
                f"{op_name}.{spec.name}: disabled_when references {path!r} "
                f"with value(s) {bad} not in its choices {referenced.choices}"
            )


def op(
    name: str,
    params: list[ParamSpec] | None = None,
    *,
    label: str = "",
    description: str = "",
    writes_alpha: bool = False,
) -> Callable[[OpFn], OpFn]:
    """Decorator; registers a pure fn (RGBA8 ndarray, params dict) -> RGBA8 ndarray.

    `label`/`description` are presentation-only metadata surfaced through
    `list_ops` — the stable identifier for scene files, scope keys and
    dispatch stays `name`, always. When `label` is omitted, one is derived
    from `name` at serialisation time (see `default_label`).

    Ops are pure, deterministic (seeded randomness only), same-size RGBA8
    in and out, and never mutate their input. By default they also leave
    alpha untouched — an op that must write into or erase transparency
    declares `writes_alpha=True` and is held to every other clause
    unchanged.
    """

    def decorator(fn: OpFn) -> OpFn:
        param_list = params or []
        params_by_name = {p.name: p for p in param_list}
        for spec in param_list:
            _validate_disabled_when(name, spec, params_by_name)

        OPS[name] = Op(
            name=name,
            backend="python",
            params=param_list,
            fn=fn,
            label=label,
            description=description,
            writes_alpha=writes_alpha,
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
from ops import colourise as _colourise  # noqa: E402, F401
from ops import desaturate as _desaturate  # noqa: E402, F401
from ops import dilate as _dilate  # noqa: E402, F401
from ops import edge_noise as _edge_noise  # noqa: E402, F401
from ops import erode as _erode  # noqa: E402, F401
from ops import gaussian_blur as _gaussian_blur  # noqa: E402, F401
from ops import grain as _grain  # noqa: E402, F401
from ops import hatch as _hatch  # noqa: E402, F401
from ops import ink_starved as _ink_starved  # noqa: E402, F401
from ops import invert as _invert  # noqa: E402, F401
from ops import levels as _levels  # noqa: E402, F401
from ops import pixelate as _pixelate  # noqa: E402, F401
from ops import recolour as _recolour  # noqa: E402, F401
from ops import smear as _smear  # noqa: E402, F401
from ops import threshold as _threshold  # noqa: E402, F401
from ops import xerox as _xerox  # noqa: E402, F401
