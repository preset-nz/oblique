"""`film_burn` — the film stalls in the projector gate and the lamp's heat
eats the frame: a blister bubbles up, the emulsion chars, the image burns
through.

**One scalar field, four zones read off it — not four separate effects.**
For every pixel:

```
d01  = (distance to the NEAREST of `count` hot spots) / diagonal   # 0 at a hot spot, <= 1 everywhere
burn = progress * REACH - d01 + noise_field(..., profile="smooth") * irregularity * 0.5
```

`diagonal = hypot(h, w)` — normalising by the *full-frame* diagonal, not
just the nearest edge, guarantees `d01 <= 1` at every pixel for any hot
spot position (the farthest any point in a `w x h` rectangle can be from
another is exactly its diagonal). `REACH` is a small constant fix-up
(`1.0 + 3*char_w + 0.5*irregularity`, plus a tiny epsilon for float
safety) so that `progress = 1.0` provably drives `burn` past the
burn-through threshold *everywhere*, not merely at the frame's worst
corner — the naive `progress - d01 + noise` used in the backlog sketch
only reaches `burn >= 0` at `progress = 1`, which is just the *edge* of
the blister band, not the promised "frame consumed". Judgement call,
recorded loudly: the backlog entry's own guarantee needed this fix-up to
actually hold.

**Hot spots are seed-driven, not positioned.** `count` points are drawn
uniformly from `np.random.default_rng(seed)` as a single `(count, 2)`
array, so the first spot is identical across every `count` value at a
given seed — `count=4`'s coverage is a strict superset of `count=1`'s.
No point-picker field kind exists yet (two normalised sliders is a bad
placement UI — you can't see where you're dropping a point while
dragging a number), the same wall that parked `stargazer`'s manual
placement; `film_burn` follows `xerox`/`ink_starved`/`edge_noise` in
taking no coordinates at all.

**Four zones, smoothstepped, not hard-cut.** Let
`char_w = max(1e-3, char * 0.25)` be the band width in field units:

| `burn`                | zone          | effect                                                   |
|------------------------|---------------|-----------------------------------------------------------|
| `<= 0`                 | intact        | untouched                                                  |
| `0 .. char_w`          | **blister**   | displace outward + brighten and desaturate                |
| `char_w .. 2*char_w`   | **scorch**    | RGB replaced with `char_colour` (the darkening *is* the tint — no second multiplier) |
| `> 2*char_w`           | **burn-through** | per `hole`                                              |

Three `smoothstep(edge0, edge1, burn)` curves, each `char_w` wide and
edge-to-edge with the next (`on` over `[0, char_w]`, `scorched` over
`[char_w, 2*char_w]`, `holed` over `[2*char_w, 3*char_w]`), combine into
zone weights `blister_w = on*(1-scorched)`, `scorch_w =
scorched*(1-holed)`, `hole_w = holed`, and `intact_w = 1 - on`. These
four weights sum to exactly 1 at every pixel (the bands are disjoint and
monotone, so whenever one is still rising to 1 the previous one has
already saturated) — the final image is a genuine weighted blend across
zones, not a `where`-cascade, which is what keeps the boundaries smooth
instead of posterised rings. `REACH` folds in the `3*char_w` upper edge
of the `holed` transition, since that is the field value the burn axis
must clear for `progress = 1` to guarantee full burn-through.

**The warp, sign pinned.** `d01` is a nearest-of-`count` distance field;
its outward unit vector at each pixel is the normalised vector from that
pixel's *nearest* hot spot to the pixel itself — the exact analytic
gradient of `d01` (a distance field's gradient is always the radial unit
vector away from its source), computed directly from the same
nearest-hot-spot lookup used for `d01` rather than via `np.gradient`.
`np.gradient` on a nearest-of-N field has a Voronoi seam between hot
spots where central differences are ill-conditioned (the min of several
cones is a ridge) — the closed-form vector sidesteps that seam cleanly
for every `count`. Displacement magnitude is `bubble * blister_w * 0.05 *
diagonal` px — a fraction of the diagonal, so it is resolution-independent
and needs no `scale="spatial"` param, and keyed off `blister_w` alone so
displacement fades back to zero once a pixel has scorched past the
blister band (a blister that has already charred stops stretching).
Content is gathered from `coord - displacement * outward_normal`, the
same "sample from where it came from" convention `edge_noise.py:178`
uses — since content is pulled in from *nearer* the hot spot, it reads on
screen as pixels pushed *away* from the hot spot, the required visual
(pinned by a centroid test, not just asserted). All four channels are
warped together (unlike `edge_noise`, which only ever warps alpha) —
RGB must move with alpha here, since it is the image content itself that
blisters. Guarded by `bubble > 0` (both for float exactness in the
`bubble=0` alpha-identity test below, and because it is free perf).

**`hole` semantics.** `white` blows RGB to white and leaves alpha
untouched — "the hole is the lamp", self-contained on one node with no
help from the stack below. `transparent` drives alpha to 0 instead so the
stack below shows through the burn — compositor-native. Both branches use
white RGB in the fully-holed core (harmless under `transparent`, since
alpha there is 0 and the RGB is inert cargo — this op does not promise
anything about what's under a hole's RGB, only that its alpha reaches 0).
`writes_alpha=True` unconditionally, since `transparent` can erase alpha
and the flag is static per op; a targeted test pins `hole="white"` +
`bubble=0` -> output alpha byte-identical to the input, replacing the
battery coverage the declaration forfeits (`bubble > 0` legitimately
warps alpha, so that combination is excluded from the identity claim,
same pattern as `bloom`'s `spill=False` test).

**Blister brighten/desaturate** are two small named constants
(`_BLISTER_BRIGHTEN`, `_BLISTER_DESATURATE`) rather than exposed params —
the story specs nine params, not eleven.

Draft honesty note: the warp displacement is expressed as a fraction of
the diagonal (like `bloom`'s `radius`), so it scales cleanly with DRAFT
resolution — but the noise field that wobbles the boundary is still
whatever 1/8 DRAFT decimated it down to, the same "screen ops skip draft
precision" gap `edge_noise.py`'s own draft-honesty note already
documents for the identical `noise_field` call.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import LUMA_B709, LUMA_G709, LUMA_R709, P, hex_to_rgb01, op
from ops._noise import noise_field
from ops._warp import bilinear_sample

_DEFAULT_CHAR_COLOUR = "#2a1608"
_DEFAULT_CHAR_COLOUR_RGB01 = hex_to_rgb01(_DEFAULT_CHAR_COLOUR, (0.0, 0.0, 0.0))

# `progress * REACH` must clear the far edge of the burn-through band
# (`3 * char_w`) even at the field's worst case (`d01 = 1`, noise at its
# most negative, `-irregularity * 0.5`) — see the module docstring's
# "REACH" paragraph. `_REACH_EPS` is a tiny safety margin so float
# rounding never leaves the worst-case pixel a hair short of the
# `smoothstep` upper edge.
_REACH_EPS = 1e-3

# Blister zone: slight brighten (flat add, pre-clip) and desaturate
# (fractional pull toward the pixel's own luma) — the emulsion softening
# and stretching under the heat, not yet charred.
_BLISTER_BRIGHTEN = 28.0
_BLISTER_DESATURATE = 0.35


def _smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    width = max(edge1 - edge0, 1e-9)
    t = np.clip((x - edge0) / width, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


@op(
    "film_burn",
    label="Film Burn",
    description="The film stalls in the gate: a blister bubbles up, the emulsion chars, the image burns through.",
    writes_alpha=True,
    params=[
        P("progress", "float", min=0.0, max=1.0, default=0.0, step=0.01, scale="none"),
        P(
            "count",
            "int",
            min=1,
            max=4,
            default=1,
            step=1,
            scale="none",
            widget="slider",
        ),
        P(
            "irregularity",
            "float",
            min=0.0,
            max=1.0,
            default=0.5,
            step=0.01,
            scale="none",
        ),
        P(
            "scale",
            "float",
            min=1.0,
            max=128.0,
            default=24.0,
            step=0.5,
            scale="spatial",
        ),
        P("bubble", "float", min=0.0, max=1.0, default=0.6, step=0.01, scale="none"),
        P("char", "float", min=0.0, max=1.0, default=0.4, step=0.01, scale="none"),
        P("char_colour", "color", default=_DEFAULT_CHAR_COLOUR),
        P("hole", "enum", default="white", choices=("white", "transparent")),
        P("seed", "int", min=0, max=2**31 - 1, default=0, step=1, scale="none"),
    ],
)
def film_burn(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    progress = float(params.get("progress", 0.0))
    count = int(params.get("count", 1))
    irregularity = float(params.get("irregularity", 0.5))
    scale = max(1e-6, float(params.get("scale", 24.0)))
    bubble = float(params.get("bubble", 0.6))
    char = float(params.get("char", 0.4))
    r01, g01, b01 = hex_to_rgb01(
        params.get("char_colour", _DEFAULT_CHAR_COLOUR), _DEFAULT_CHAR_COLOUR_RGB01
    )
    char_colour255 = np.array([r01, g01, b01], dtype=np.float64) * 255.0
    hole = str(params.get("hole", "white"))
    seed = int(params.get("seed", 0))

    out = img.copy()
    if progress <= 0.0:
        return out

    h, w = out.shape[:2]
    count = max(1, min(4, count))
    diagonal = max(float(np.hypot(h, w)), 1e-6)
    char_w = max(1e-3, char * 0.25)

    # --- hot spots: a single (count, 2) draw so `count=1`'s spot is the
    # first row of `count=4`'s draw at the same seed (coverage is a strict
    # superset, not an unrelated resample). ---------------------------------
    rng = np.random.default_rng(seed)
    spots01 = rng.uniform(0.0, 1.0, size=(count, 2))
    spots_y = spots01[:, 0] * (h - 1)
    spots_x = spots01[:, 1] * (w - 1)

    # Row/column vectors that broadcast to (h, w) on demand — never
    # materialised as full grids. See the memory note in the docstring.
    yy = np.arange(h, dtype=np.float64)[:, None]
    xx = np.arange(w, dtype=np.float64)[None, :]

    # Nearest-of-`count` distance, accumulated one hot spot at a time.
    # The obvious vectorisation — an (h, w, count) distance stack plus
    # `argmin` — is three full float64 volumes of temporaries per axis,
    # which at 2048x2048 peaks in the gigabytes for a 17 MB image and
    # would be tens of gigabytes on a large scan. Strict `<` keeps the
    # lowest-index spot on a tie, matching `argmin` exactly.
    min_dist: np.ndarray | None = None
    vec_y: np.ndarray | None = None
    vec_x: np.ndarray | None = None
    for i in range(count):
        dy_i = np.broadcast_to(yy - spots_y[i], (h, w))
        dx_i = np.broadcast_to(xx - spots_x[i], (h, w))
        dist_i = np.hypot(dy_i, dx_i)
        if min_dist is None:
            min_dist, vec_y, vec_x = dist_i, dy_i.copy(), dx_i.copy()
        else:
            closer = dist_i < min_dist
            min_dist = np.where(closer, dist_i, min_dist)
            vec_y = np.where(closer, dy_i, vec_y)
            vec_x = np.where(closer, dx_i, vec_x)

    d01 = np.clip(min_dist / diagonal, 0.0, 1.0)

    # `min_dist` IS the length of (vec_y, vec_x) — no need to recompute it.
    safe_length = np.where(min_dist > 1e-9, min_dist, 1.0)
    outward_y = np.where(min_dist > 1e-9, vec_y / safe_length, 0.0)
    outward_x = np.where(min_dist > 1e-9, vec_x / safe_length, 0.0)

    noise = noise_field(h, w, scale, seed, "smooth")

    reach = 1.0 + 3.0 * char_w + 0.5 * irregularity + _REACH_EPS
    burn = progress * reach - d01 + noise * irregularity * 0.5

    on = _smoothstep(0.0, char_w, burn)
    scorched = _smoothstep(char_w, 2.0 * char_w, burn)
    holed = _smoothstep(2.0 * char_w, 3.0 * char_w, burn)

    intact_w = 1.0 - on
    blister_w = on * (1.0 - scorched)
    scorch_w = scorched * (1.0 - holed)
    hole_w = holed

    if not np.any(on > 0.0):
        # No pixel crosses into the blister band at all — exact no-op,
        # same discipline `bloom`/`edge_noise` use for their own
        # nothing-would-change early-outs.
        return out

    # --- warp: displace the sampling coordinate outward, magnitude keyed
    # to the blister weight alone so it fades back to zero once a pixel
    # has scorched past the blister band. ------------------------------
    img_f = out.astype(np.float64)
    if bubble > 0.0:
        displacement = bubble * blister_w * 0.05 * diagonal
        sample_y = yy - displacement * outward_y
        sample_x = xx - displacement * outward_x
        # Filled channel by channel into one preallocated array — a list
        # of four (h, w) planes plus the `np.stack` copy of them doubles
        # the peak for no benefit.
        base = np.empty((h, w, 4), dtype=np.float64)
        for c in range(4):
            base[..., c] = bilinear_sample(img_f[..., c], sample_y, sample_x)
    else:
        base = img_f

    base_rgb = base[..., :3]
    base_a = base[..., 3]

    # --- blister: brighten + desaturate toward the pixel's own luma ----
    luma = (
        LUMA_R709 * base_rgb[..., 0]
        + LUMA_G709 * base_rgb[..., 1]
        + LUMA_B709 * base_rgb[..., 2]
    )
    desaturated = base_rgb * (1.0 - _BLISTER_DESATURATE) + (
        luma[..., None] * _BLISTER_DESATURATE
    )
    blister_rgb = np.clip(desaturated + _BLISTER_BRIGHTEN, 0.0, 255.0)

    # --- scorch: RGB replaced outright by char_colour — the lerp *is*
    # the darkening, no second multiplier on top of it. ------------------
    scorch_rgb = np.broadcast_to(char_colour255, base_rgb.shape)

    # --- burn-through: RGB blown white either way; `hole` only decides
    # what happens to alpha. ---------------------------------------------
    # White as a scalar, not a full (h, w, 3) array of 255s — it only
    # ever gets multiplied by `hole_w`, and materialising it costs as
    # much as another copy of the image.
    hole_rgb = 255.0
    hole_a = 0.0 if hole == "transparent" else base_a

    final_rgb = (
        intact_w[..., None] * base_rgb
        + blister_w[..., None] * blister_rgb
        + scorch_w[..., None] * scorch_rgb
        + hole_w[..., None] * hole_rgb
    )
    final_a = base_a * (1.0 - hole_w) + hole_a * hole_w

    out[..., :3] = np.round(np.clip(final_rgb, 0.0, 255.0)).astype(np.uint8)
    out[..., 3] = np.round(np.clip(final_a, 0.0, 255.0)).astype(np.uint8)
    return out
