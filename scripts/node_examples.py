"""Example images for the node pages: `just examples`.

Takes the sample render (docs/nodes/img/sample-source.png, made in Draw
Things with Flux.1 schnell), adds a colour strip of the family's icon
colours, a grey wedge and pure inks down its right edge, cuts the stack out
with Oblique's own MobileSAM, then runs every op on it twice: at its
defaults and with one recipe from its page. The images land in
docs/nodes/img/, and each op page gets an Examples block between markers,
rewritten on every run like the generator's block. A crop of the recipe
image, halved, is the op's thumbnail in the index: the page names it under
`thumbnail:` and `just docs` puts it in the table.

The ops are called directly, at full size, so a spatial value here is the
value in the inspector at baked resolution.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sidecar"))

import ops
from ml.session import ModelNotInstalled, run_segment, weight_paths

PAGES = ROOT / "docs" / "nodes"
IMG = PAGES / "img"
SOURCE = IMG / "sample-source.png"
ICONS = ROOT.parent  # the sibling app repos
# app-kit's machine-wide models folder (models.md). The weights get there from Smart Select's
# download prompt in the app; this script never fetches.
MOBILE_SAM = Path.home() / "Library/Application Support/rhizomatic/models/mobile_sam"

# Where the stack sits in the source, for the segmentation prompt.
STACK_BOX = {"x0": 170, "y0": 172, "x1": 620, "y1": 590}

# Ops that act on a shape's outline run on the cut-out, not the whole frame.
OUTLINE_OPS = {"dilate", "erode", "edge_noise"}

# The thumbnail: a crop of the recipe image at the stack's top right corner,
# so it holds layers, the crack and an outline against the backdrop, halved.
# A crop rather than the whole frame shrunk, so screens and grain still read.
THUMB_BOX = (372, 168, 628, 424)
THUMB_SIZE = 128

# Ops whose defaults change nothing get no defaults image.
NO_OP_DEFAULTS = {"film_burn", "levels"}

Chain = list[tuple[str, dict[str, Any]]]

# One pushed look per op: strong enough to read at a glance on the page. The
# defaults image beside it shows the gentle end.
RECIPES: dict[str, tuple[str, Chain]] = {
    "bloom": (
        "Everything glows",
        [
            (
                "bloom",
                {"threshold": 0.7, "radius": 60.0, "intensity": 1.5, "blend": "screen"},
            )
        ],
    ),
    "cmyk_halftone": (
        "Big riso dots, out of register",
        [
            (
                "cmyk_halftone",
                {
                    "ink_c": "#1f8a8a",
                    "ink_m": "#ff3d9a",
                    "ink_y": "#f5e9a0",
                    "ink_k": "#1b2440",
                    "dot_size": 24.0,
                    "misregistration": 6.0,
                },
            )
        ],
    ),
    "colour_crush": ("One bit a channel", [("colour_crush", {"bits": 1})]),
    "colour_keep": (
        "Only Oblique's aqua and Shard's lavender",
        [
            (
                "colour_keep",
                {
                    "keep": "#a2e2e3",
                    "hue_range": 25.0,
                    "softness": 10.0,
                    "min_saturation": 0.15,
                    "use_keep_2": True,
                    "keep_2": "#bd9ee7",
                    "hue_range_2": 25.0,
                },
            )
        ],
    ),
    "colourise": (
        "Cyanotype",
        [
            ("levels", {"black": 40.0, "white": 215.0}),
            ("colourise", {"colour": "#1f3a8a", "preserve_luma": False}),
        ],
    ),
    "desaturate": (
        "Faded to almost nothing",
        [
            ("desaturate", {"amount": 0.85}),
            ("film_stock", {"stock": "sx70", "vignette": 1.0, "grain": 1.0}),
        ],
    ),
    "dilate": (
        "Swollen and torn",
        [("dilate", {"radius": 14.0}), ("edge_noise", {"amount": 0.8, "scale": 30.0})],
    ),
    "edge_noise": (
        "Bitten",
        [("edge_noise", {"amount": 1.0, "scale": 36.0, "profile": "saw"})],
    ),
    "erode": ("Eaten away", [("erode", {"radius": 16.0})]),
    "film_burn": (
        "Burnt through",
        [
            (
                "film_burn",
                {"progress": 0.3, "count": 2, "irregularity": 0.1, "scale": 48.0},
            ),
            ("bloom", {"threshold": 0.9, "radius": 40.0}),
        ],
    ),
    "film_stock": (
        "Expired roll",
        [
            (
                "film_stock",
                {"stock": "expired", "vignette": 1.0, "grain": 1.0, "seed": 3},
            )
        ],
    ),
    "gaussian_blur": ("Out of focus", [("gaussian_blur", {"radius": 30.0})]),
    "grain": (
        "Rough black and white",
        [
            ("threshold", {"level": 127.0}),
            ("gaussian_blur", {"radius": 2.0}),
            ("grain", {"amount": 0.6, "size": 5}),
        ],
    ),
    "hatch": (
        "Pen drawing",
        [
            ("gaussian_blur", {"radius": 3.0}),
            (
                "hatch",
                {
                    "pattern": "lines",
                    "layers": 3,
                    "spacing": 12.0,
                    "angle": 30.0,
                    "pen": 0.6,
                    "jitter": 0.4,
                },
            ),
        ],
    ),
    "ink_starved": (
        "Run dry",
        [
            (
                "ink_starved",
                {
                    "direction": "h",
                    "starvation": 1.0,
                    "banding": 0.7,
                    "banding_period": 36.0,
                },
            )
        ],
    ),
    "invert": ("Cut and flip", [("threshold", {"level": 127.0}), ("invert", {})]),
    "levels": ("Crushed hard", [("levels", {"black": 100.0, "white": 175.0})]),
    "pixelate": (
        "Low-res",
        [
            ("pixelate", {"cell_size": 32}),
            ("colour_crush", {"bits": 2, "dither": True}),
        ],
    ),
    "recolour": (
        "Shard duotone",
        [("recolour", {"stops": 2, "stop_1": "#2a1f3d", "stop_2": "#f1e094"})],
    ),
    "smear": (
        "Scanner stall",
        [("smear", {"direction": "h", "mode": "both", "position": 0.45})],
    ),
    "technicolor": (
        "Heavy two-strip misprint",
        [
            (
                "technicolor",
                {
                    "process": "two_strip",
                    "dye_density": 1.6,
                    "cross_talk": 0.3,
                    "fringe": 8.0,
                    "amount": 1.0,
                },
            )
        ],
    ),
    "threshold": (
        "Clean shapes",
        [("gaussian_blur", {"radius": 3.0}), ("threshold", {"level": 150.0})],
    ),
    "xerox": (
        "Nine generations down",
        [
            (
                "xerox",
                {
                    "generations": 9,
                    "skew": 1.2,
                    "toner_noise": 0.5,
                    "edge_bloom": 0.4,
                    "bloom_radius": 6.0,
                },
            )
        ],
    ),
}


# --- the sample ---------------------------------------------------------------


def icon_colours(app: str, count: int = 4) -> list[tuple[int, int, int]]:
    """The icon's `count` commonest colours, darkest first."""
    icon = Image.open(ICONS / app / "src-tauri/icons/128x128@2x.png").convert("RGBA")
    pixels = np.asarray(icon).reshape(-1, 4)
    opaque = pixels[pixels[:, 3] > 200, :3]
    strip = Image.fromarray(opaque[None, :, :])
    quantised = strip.quantize(6, method=Image.Quantize.MEDIANCUT)
    palette = quantised.getpalette() or []
    common = sorted(quantised.getcolors() or [], reverse=True)[:count]
    colours = [tuple(palette[i * 3 : i * 3 + 3]) for _, i in common]
    return sorted(colours, key=lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])


def strip_colours() -> list[tuple[int, int, int]]:
    # Map & Territory's icon is Strata's tint, so four apps cover the family.
    apps = [
        c for app in ("oblique", "shard", "strata", "fault") for c in icon_colours(app)
    ]
    wedge = [(round(255 * i / 10),) * 3 for i in range(11)]
    inks = [
        (0, 255, 255),
        (255, 0, 255),
        (255, 255, 0),
        (0, 0, 0),
        (255, 0, 0),
        (0, 255, 0),
        (0, 0, 255),
    ]
    return apps + wedge + inks


def register_mark(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int) -> None:
    draw.ellipse(
        (cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2), outline=(0, 0, 0), width=1
    )
    draw.line((cx - r, cy, cx + r, cy), fill=(0, 0, 0), width=1)
    draw.line((cx, cy - r, cx, cy + r), fill=(0, 0, 0), width=1)


def with_strip(source: Image.Image) -> Image.Image:
    """The source with a press-sheet colour bar down its right edge."""
    image = source.convert("RGBA")
    width, height = image.size
    colours = strip_colours()
    margin = 30  # top and bottom, for the registration marks
    patch = (height - 2 * margin) // len(colours)
    x0 = width - 20 - patch
    y0 = (height - patch * len(colours)) // 2
    draw = ImageDraw.Draw(image)
    for i, colour in enumerate(colours):
        y = y0 + i * patch
        draw.rectangle((x0, y, x0 + patch - 1, y + patch - 1), fill=(*colour, 255))
    draw.rectangle(
        (x0 - 1, y0 - 1, x0 + patch, y0 + patch * len(colours)), outline=(0, 0, 0)
    )
    register_mark(draw, x0 + patch // 2, y0 - 15, 8)
    register_mark(draw, x0 + patch // 2, y0 + patch * len(colours) + 15, 8)
    return image


def cut_out(rgba: np.ndarray) -> np.ndarray:
    try:
        encoder, decoder = weight_paths(MOBILE_SAM)
    except ModelNotInstalled:
        sys.exit(
            "MobileSAM isn't installed: choose Smart Select in Oblique once and download it "
            f"(it lands in {MOBILE_SAM})."
        )
    mask = run_segment(
        encoder_path=encoder,
        decoder_path=decoder,
        rgba=rgba,
        prompt={"box": STACK_BOX},
        coarse_mask=None,
    )
    out = rgba.copy()
    out[..., 3] = np.where(mask, 255, 0).astype(np.uint8)
    return out


# --- the examples ---------------------------------------------------------------


def label(item: Any) -> str:
    return item.label or ops.default_label(item.name)


def run(img: np.ndarray, chain: Chain) -> np.ndarray:
    for name, overrides in chain:
        op = ops.OPS[name]
        params = {p.name: p.default for p in op.params} | overrides
        img = op.fn(img, params)
    return img


def save(img: np.ndarray, name: str) -> str:
    Image.fromarray(img, "RGBA").save(IMG / name, "WEBP", quality=85, method=6)
    return name


def save_thumb(img: np.ndarray, name: str) -> str:
    crop = Image.fromarray(img, "RGBA").crop(THUMB_BOX)
    crop.resize((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS).save(
        IMG / name, "WEBP", quality=85, method=6
    )
    return name


def value(spec: Any, v: Any) -> str:
    if spec.choice_labels and v in spec.choice_labels:
        return spec.choice_labels[v]
    if isinstance(v, bool):
        return "on" if v else "off"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def shown(name: str, overrides: dict[str, Any]) -> str:
    """The settings a step changes, by the labels in the inspector."""
    specs = {p.name: p for p in ops.OPS[name].params}
    return ", ".join(
        f"{label(specs[k])} {value(specs[k], v)}" for k, v in overrides.items()
    )


def settings(chain: Chain) -> str:
    def step(name: str, overrides: dict[str, Any]) -> str:
        op_label = label(ops.OPS[name])
        changed = shown(name, overrides)
        return f"{op_label} ({changed})" if changed else op_label

    return ", then ".join(step(name, o) for name, o in chain)


def alt(name: str, title: str, chain: Chain) -> str:
    """The recipe image's alt: the node, the recipe and its settings."""
    node = label(ops.OPS[name])
    # The node alone needs its settings, not its name again.
    alone = len(chain) == 1 and chain[0][0] == name
    detail = shown(*chain[0]) if alone else settings(chain)
    return f'{node}, "{title}": {detail}' if detail else f'{node}, "{title}"'


BEGIN = (
    "<!-- examples:begin — `just examples` rewrites this block; write outside it -->"
)
END = "<!-- examples:end -->"
BLOCK = re.compile(
    r"\n*(## Examples\n+)*<!-- examples:begin.*?<!-- examples:end -->\n*", re.DOTALL
)


def write_block(page: Path, lines: list[str]) -> None:
    text = BLOCK.sub("\n", page.read_text()).rstrip("\n")
    block = "\n".join(["## Examples", "", BEGIN, *lines, END])
    page.write_text(f"{text}\n\n{block}\n")


THUMB_KEY = re.compile(r"^thumbnail:.*\n", re.MULTILINE)


def write_thumbnail(page: Path, file: str) -> None:
    """Names the thumbnail in the page's front matter, after the generator's keys."""
    text = page.read_text()
    end = text.index("\n---\n", 4) + 1
    front = THUMB_KEY.sub("", text[:end])
    page.write_text(f"{front}thumbnail: img/{file}\n{text[end:]}")


def main() -> None:
    sample = with_strip(Image.open(SOURCE))
    sample.save(IMG / "sample.png")
    rgba = np.asarray(sample).copy()
    cutout = cut_out(np.asarray(Image.open(SOURCE).convert("RGBA")).copy())
    Image.fromarray(cutout, "RGBA").save(IMG / "sample-cutout.png")

    for name, (title, chain) in RECIPES.items():
        page = PAGES / f"op.{name}.md"
        base = cutout if name in OUTLINE_OPS else rgba
        lines = []
        if name not in NO_OP_DEFAULTS:
            file = save(run(base, [(name, {})]), f"{name}-defaults.webp")
            lines += [
                f"![{label(ops.OPS[name])} at its defaults](img/{file})",
                "",
                "*Defaults.*",
                "",
            ]
        recipe = run(base, chain)
        file = save(recipe, f"{name}-recipe.webp")
        lines += [
            f"![{alt(name, title, chain)}](img/{file})",
            "",
            f"*{title}: {settings(chain)}.*",
        ]
        write_block(page, lines)
        write_thumbnail(page, save_thumb(recipe, f"{name}-thumb.webp"))
        print(f"examples: {name}")


if __name__ == "__main__":
    main()
