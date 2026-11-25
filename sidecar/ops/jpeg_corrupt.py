"""`jpeg_corrupt` — a grimdark mainframe eaten by something alive: colonies of
broken JPEG blocks that spread through the picture and throw spores ahead of
themselves. It really damages the bytes of a JPEG; it doesn't imitate the look.

**Why restart markers.** Damage in the middle of a JPEG's entropy-coded scan
normally runs on to the end of the picture: every code after the hit is read
out of step. A restart marker (`FFD0`–`FFD7`) is a re-sync point, and the file
can be told to put one after every `smear` blocks (`restart_marker_blocks`).
Damage then stops at the next marker: one hit ruins its own run of blocks and
nothing past it (checked 2026-11-25 with Pillow 13, `smear=1`: a byte flipped
in interval *i* changes pixels only in MCU *i*). That is what makes a seeded,
spreading infection possible.

**The pipeline.** Encode the RGB as a baseline JPEG with a marker every
`smear` MCUs. Find the intervals between markers. Order the intervals by how
soon the infection reaches them. Infect the first `round(progress * n)` of
that order by damaging bytes inside them. Decode. Keep every pixel of every
clean MCU from the input.

**The order is the animation.** It depends on the image size and every param
except `progress` and `variant`, so a higher `progress` infects a strict
superset (frames only gain damage: growth, not flicker). Each interval's key:

```
key = distance(interval centre, nearest colony) / grid diagonal
      + noise_field(smooth) at the centre * irregularity * 0.5       # a ragged front
key = random in [0, 1]   for a `spores` share of intervals           # hit ahead of the front
```

sorted ascending, stable, ties by interval index. Everything is measured on
the MCU grid, in MCUs, so the spread looks the same however big the picture or
the block size is, and a DRAFT preview (image and `block` both shrunk) lands
on the same grid as the full cook. Colonies are one `(colonies, 2)` draw from
`default_rng(seed)`, so colony 1 is the same for every count (as in
`film_burn`); the spore share is `rng.random(n) < spores` over full-length
draws, so a higher `spores` only adds spores. An interval runs along raster
order and can wrap onto the next row when `smear` doesn't divide the row; its
position is its *middle MCU*, not the mean of its MCUs (which would land
mid-row).

**Damage is seeded per interval**: `default_rng([seed, variant, interval])`.
An interval's damage never changes as `progress` grows, and `variant` re-rolls
it without moving the colonies. Three modes: `flip` (XOR a byte), `replace`
(a random byte), `shift` (insert or delete a byte, which knocks the rest of
the interval out of step: the slip and the garbage).

**Byte stuffing.** In scan data a literal `0xFF` is written `FF 00`, and `FF
Dn` is a marker. So damage never touches a `0xFF` byte or the byte right after
one, never writes `0xFF`, and leaves the first and last byte of an interval
alone; either of the first two would break the re-sync and the damage would
run on to the end of the picture. An insert goes before an eligible byte,
whose predecessor is therefore not `0xFF`, so a stuffing pair is never split.
Hits land on distinct bytes (a collision means one fewer hit), applied from
the back so inserts and deletes don't move the positions still to apply.

**Block size.** One MCU is 16 px at 4:2:0 and 8 px at 4:4:4. `block` is how
big the op makes one MCU look: the RGB is resized by `mcu / block` (box when
shrinking, bilinear when enlarging), damaged, and the result and the infected
mask are resized back with nearest-neighbour, the same call for both so the
edges line up. `block` is `scale="spatial"`, so a draft keeps the look in
proportion. It isn't clamped here: a draft passes a smaller value than its
range.

**Failure is quiet.** A damaged file that Pillow can't decode is tried once
more with `variant + 1_000_003`; if that fails too, or if the marker count
isn't what the grid says it must be, the input comes back unchanged. Never an
empty layer. `LOAD_TRUNCATED_IMAGES` is switched on only around the decode.

**Alpha** is set aside and put back unchanged (`writes_alpha` stays False).

How a decoder handles damaged data isn't part of the JPEG standard, so the
same bytes can look different after a Pillow upgrade. Pillow is pinned by
`uv.lock`; `test_jpeg_corrupt.py` keeps a hash of one result to catch a change.
"""

from __future__ import annotations

import io
from typing import Any

import numpy as np
from PIL import Image, ImageFile

from ops import P, op
from ops._noise import noise_field

# The decoder retry: a different variant means different damage.
_RETRY_VARIANT_OFFSET = 1_000_003

# Feature size of the ragged front, in MCUs. Looked at on a 48 x 48 grid with
# three colonies: 4 breaks the front into scattered fragments (every noise dip
# starts a colony of its own), 16 leaves a few smooth blobs; 10 reads as
# colonies with ragged edges and a few islands.
_NOISE_SCALE_MCUS = 10.0
# So the front's noise isn't the same stream as the colony draw.
_NOISE_SEED_OFFSET = 0x5EED


def _mcu_size(chroma: str) -> int:
    return 16 if chroma == "420" else 8


def _infection_order(
    rows: int,
    cols: int,
    smear: int,
    colonies: int,
    spores: float,
    irregularity: float,
    seed: int,
) -> np.ndarray:
    """Interval indices in the order the infection reaches them. Depends on the
    grid, `smear`, `colonies`, `spores`, `irregularity` and `seed` only."""
    n_mcu = rows * cols
    n_int = -(-n_mcu // smear)
    first = np.arange(n_int) * smear
    last = np.minimum(first + smear, n_mcu) - 1
    middle = (first + last) // 2
    mid_row = middle // cols
    mid_col = middle % cols

    rng = np.random.default_rng(seed)
    points = rng.uniform(0.0, 1.0, size=(colonies, 2)) * np.array([rows, cols])
    centre_y = (mid_row + 0.5)[:, None]
    centre_x = (mid_col + 0.5)[:, None]
    dist = np.hypot(centre_y - points[None, :, 0], centre_x - points[None, :, 1])
    diagonal = max(float(np.hypot(rows, cols)), 1e-6)
    key = dist.min(axis=1) / diagonal

    if irregularity > 0.0:
        noise = noise_field(
            rows, cols, _NOISE_SCALE_MCUS, seed + _NOISE_SEED_OFFSET, "smooth"
        )
        key = key + noise[mid_row, mid_col] * irregularity * 0.5

    is_spore = rng.random(n_int) < spores
    spore_key = rng.random(n_int)
    key = np.where(is_spore, spore_key, key)
    return np.argsort(key, kind="stable")


def _infected_count(progress: float, n_int: int) -> int:
    return int(np.clip(np.floor(progress * n_int + 0.5), 0, n_int))


def _infected_mcus(
    rows: int, cols: int, smear: int, order: np.ndarray, count: int
) -> np.ndarray:
    """`(rows, cols)` bool: the MCUs inside the first `count` intervals of `order`."""
    n_mcu = rows * cols
    infected = np.zeros(len(order), dtype=bool)
    infected[order[:count]] = True
    return infected[np.arange(n_mcu) // smear].reshape(rows, cols)


def _scan_start(data: bytes) -> int | None:
    """Offset of the first entropy-coded byte: walks the header segments to
    the start-of-scan marker and skips its length."""
    pos = 2
    while pos + 4 <= len(data) and data[pos] == 0xFF:
        marker = data[pos + 1]
        if marker == 0xDA:
            return pos + 2 + ((data[pos + 2] << 8) | data[pos + 3])
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            pos += 2
        else:
            pos += 2 + ((data[pos + 2] << 8) | data[pos + 3])
    return None


def _intervals(data: bytes) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """`(starts, ends, bytes)`: where each restart interval's bytes begin and
    end (end exclusive), and the file as an array. None if it can't be read."""
    start = _scan_start(data)
    end = data.rfind(b"\xff\xd9")
    if start is None or end <= start:
        return None
    arr = np.frombuffer(data, dtype=np.uint8)
    body = arr[start:end]
    is_rst = (body[:-1] == 0xFF) & (body[1:] >= 0xD0) & (body[1:] <= 0xD7)
    rst = np.flatnonzero(is_rst) + start
    starts = np.concatenate(([start], rst + 2))
    ends = np.concatenate((rst, [end]))
    return starts, ends, arr


def _damage(
    data: bytes,
    starts: np.ndarray,
    ends: np.ndarray,
    arr: np.ndarray,
    infected: np.ndarray,
    mode: str,
    severity: int,
    seed: int,
    variant: int,
) -> bytes:
    """`data` with `severity` hits in each interval of `infected` (sorted)."""
    plain = arr != 0xFF
    allowed = plain.copy()
    allowed[1:] &= plain[:-1]  # not the byte right after a 0xFF
    allowed[starts] = False
    allowed[ends - 1] = False

    pieces: list[bytes | bytearray] = []
    cursor = 0
    for i in infected.tolist():
        a, z = int(starts[i]), int(ends[i])
        spots = np.flatnonzero(allowed[a:z])
        if spots.size == 0:
            continue
        rng = np.random.default_rng([seed, variant, i])
        picks = rng.integers(0, spots.size, size=severity)
        if mode == "flip":
            values = rng.integers(1, 256, size=severity)
        elif mode == "replace":
            values = rng.integers(0, 255, size=severity)
        else:
            values = rng.integers(0, 255, size=severity)
            deletes = rng.integers(0, 2, size=severity).astype(bool)
        picks, first = np.unique(picks, return_index=True)
        values = values[first]
        if mode == "shift":
            deletes = deletes[first]

        run = bytearray(data[a:z])
        at = spots[picks]
        if mode == "shift":
            # from the back, so earlier positions stay where they were
            for p, v, drop in zip(
                at[::-1].tolist(), values[::-1].tolist(), deletes[::-1].tolist()
            ):
                if drop:
                    del run[p]
                else:
                    run.insert(p, v)
        else:
            for p, v in zip(at.tolist(), values.tolist()):
                old = run[p]
                if mode == "flip":
                    new = old ^ v
                    if new == 0xFF:
                        new = 0xFE if old != 0xFE else 0xFD
                else:
                    new = v
                run[p] = new
        pieces.append(data[cursor:a])
        pieces.append(run)
        cursor = z
    pieces.append(data[cursor:])
    return b"".join(pieces)


def _decode(data: bytes) -> np.ndarray:
    """RGB pixels of a possibly damaged JPEG; raises if Pillow can't."""
    previous = ImageFile.LOAD_TRUNCATED_IMAGES
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    try:
        with Image.open(io.BytesIO(data)) as picture:
            picture.load()
            return np.asarray(picture.convert("RGB"))
    finally:
        ImageFile.LOAD_TRUNCATED_IMAGES = previous


def _resized(rgb: np.ndarray, size: tuple[int, int], resample: Any) -> np.ndarray:
    picture = Image.fromarray(np.ascontiguousarray(rgb))
    return np.asarray(picture.resize(size, resample))


@op(
    "jpeg_corrupt",
    category="distort",
    label="JPEG Corrupt",
    description="The file rots: colonies of broken JPEG blocks spread through the picture.",
    params=[
        P(
            "progress",
            "float",
            min=0.0,
            max=1.0,
            default=0.35,
            step=0.01,
            scale="none",
            label="Progress",
            description="How much of the picture is infected. 0 leaves it untouched; 1 infects every block.",
        ),
        P(
            "colonies",
            "int",
            min=1,
            max=12,
            default=3,
            step=1,
            scale="none",
            widget="slider",
            label="Colonies",
            description="How many places the infection starts from.",
        ),
        P(
            "spores",
            "float",
            min=0.0,
            max=1.0,
            default=0.15,
            step=0.01,
            scale="none",
            label="Spores",
            description="Share of blocks hit at random ahead of the colonies.",
        ),
        P(
            "irregularity",
            "float",
            min=0.0,
            max=1.0,
            default=0.6,
            step=0.01,
            scale="none",
            label="Irregularity",
            description="How ragged the edge of a colony is.",
        ),
        P(
            "smear",
            "int",
            min=1,
            max=64,
            default=4,
            step=1,
            scale="none",
            widget="slider",
            label="Smear",
            description="How many blocks one hit's damage can run on for, along the row.",
        ),
        P(
            "severity",
            "int",
            min=1,
            max=16,
            default=3,
            step=1,
            scale="none",
            widget="slider",
            label="Severity",
            description="Damaged bytes per infected run. More is more broken.",
        ),
        P(
            "mode",
            "enum",
            default="shift",
            choices=("flip", "replace", "shift"),
            choice_labels={
                "flip": "Flip bits",
                "replace": "Replace bytes",
                "shift": "Shift bytes",
            },
            label="Damage",
            description="What a hit does to the file: flip a byte's bits, replace a byte, or slip a byte in or out.",
        ),
        P(
            "quality",
            "int",
            min=5,
            max=95,
            default=40,
            step=1,
            scale="none",
            widget="slider",
            label="Quality",
            description="The JPEG quality the picture is saved at before it's damaged.",
        ),
        P(
            "chroma",
            "enum",
            default="420",
            choices=("420", "444"),
            choice_labels={"420": "Coarse (4:2:0)", "444": "Fine (4:4:4)"},
            label="Colour blocks",
            description="How coarse the colour is within a block. Coarse gives the chunky colour smears.",
        ),
        P(
            "block",
            "float",
            min=4.0,
            max=128.0,
            default=16.0,
            step=1.0,
            scale="spatial",
            label="Block size",
            description="Size of one damaged block, in document pixels.",
        ),
        P(
            "variant",
            "int",
            min=0,
            max=9999,
            default=0,
            step=1,
            scale="none",
            label="Variant",
            description="Re-rolls the damage inside infected blocks; the colonies stay where they are.",
        ),
        P(
            "seed",
            "int",
            min=0,
            max=9999,
            default=0,
            step=1,
            scale="none",
            label="Seed",
            description="Where the colonies and spores fall.",
        ),
    ],
)
def jpeg_corrupt(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    progress = float(params.get("progress", 0.35))
    colonies = max(1, int(params.get("colonies", 3)))
    spores = float(params.get("spores", 0.15))
    irregularity = float(params.get("irregularity", 0.6))
    smear = max(1, int(params.get("smear", 4)))
    severity = max(1, int(params.get("severity", 3)))
    mode = str(params.get("mode", "shift"))
    if mode not in ("flip", "replace", "shift"):
        mode = "shift"
    quality = int(np.clip(int(params.get("quality", 40)), 1, 95))
    chroma = "444" if str(params.get("chroma", "420")) == "444" else "420"
    block = max(1e-6, float(params.get("block", 16.0)))
    variant = max(0, int(params.get("variant", 0)))
    seed = max(0, int(params.get("seed", 0)))

    out = img.copy()
    if progress <= 0.0:
        return out

    h, w = img.shape[:2]
    mcu = _mcu_size(chroma)
    rgb = np.ascontiguousarray(img[..., :3])
    if block == mcu:
        hs, ws = h, w
        small = rgb
    else:
        factor = mcu / block
        hs, ws = max(1, round(h * factor)), max(1, round(w * factor))
        resample = Image.Resampling.BOX if factor < 1.0 else Image.Resampling.BILINEAR
        small = _resized(rgb, (ws, hs), resample)

    rows, cols = -(-hs // mcu), -(-ws // mcu)
    n_mcu = rows * cols
    n_int = -(-n_mcu // smear)
    count = _infected_count(progress, n_int)
    if count == 0:
        return out
    order = _infection_order(rows, cols, smear, colonies, spores, irregularity, seed)
    infected = np.sort(order[:count])

    buf = io.BytesIO()
    Image.fromarray(small).save(
        buf,
        "JPEG",
        quality=quality,
        subsampling=2 if chroma == "420" else 0,
        restart_marker_blocks=smear,
    )
    data = buf.getvalue()
    layout = _intervals(data)
    if layout is None or len(layout[0]) != n_int:
        return out
    starts, ends, arr = layout

    decoded = None
    for attempt in (variant, variant + _RETRY_VARIANT_OFFSET):
        try:
            damaged = _damage(
                data, starts, ends, arr, infected, mode, severity, seed, attempt
            )
            decoded = _decode(damaged)
            if decoded.shape[:2] != (hs, ws):
                decoded = None
        except Exception:  # noqa: BLE001 - a decoder may raise OSError, SyntaxError, ValueError...
            decoded = None
        if decoded is not None:
            break
    if decoded is None:
        return out

    mask = np.repeat(
        np.repeat(_infected_mcus(rows, cols, smear, order, count), mcu, axis=0),
        mcu,
        axis=1,
    )[:hs, :ws]
    if (hs, ws) != (h, w):
        decoded = _resized(decoded, (w, h), Image.Resampling.NEAREST)
        mask = np.asarray(
            Image.fromarray(mask.astype(np.uint8) * 255).resize(
                (w, h), Image.Resampling.NEAREST
            )
        ).astype(bool)
    out[..., :3] = np.where(mask[..., None], decoded, img[..., :3])
    return out
