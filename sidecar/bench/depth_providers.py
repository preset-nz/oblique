"""CPU against CoreML for the depth model (Epic 17 story 5, `depth-map.md` "Measuring CPU against
CoreML"). Run it with `just bench-depth <image>`.

It calls `ml/depth.py` the way the `depth` handler does (`estimate_depth`: resize, model, resize
back), once per provider configuration, on three inputs made from the one photo: its long side at
2048 px, at 4096 px, and the 2048 one cut out (an elliptical alpha). It prints

- load time per configuration (CoreML compiles the model when the session is made),
- the median of 10 runs after 2 warm-ups, end to end, per input,
- how many nodes CoreML took, read from onnxruntime's verbose log (written by C++ to the stderr
  file descriptor, so it is captured there), and
- the largest and mean difference in 8-bit levels against the CPU map, over the visible pixels.

CoreML gets a fixed 518 x 518 input: a dynamic shape sends the model back to the CPU. So the CPU
is measured twice: at the shipped size (the aspect ratio kept, which is what the handler runs) and
at 518 x 518. The sameness numbers compare CoreML with the 518 x 518 CPU map, so they are the
provider's difference alone; the shipped-CPU column adds the squash.

Writes `<out>/<input>_<config>.png` for each map, and for each CoreML one `_diff.png` and
`_diff_vs_shipped.png`: the absolute difference from the 518 x 518 and from the shipped CPU map,
times 8 (clipped), so a faint difference can be seen. A last CoreML configuration sets
`ModelCacheDirectory` and opens twice, to time what a cached reload saves.

The weights are not in the repo. `--model-dir` is a folder holding `model.onnx`; when the file is
missing it is downloaded there (the URL, size and SHA-256 are read from `src-tauri/src/models.rs`,
the registry that owns them, and checked) and nothing is fetched otherwise.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import os
import re
import shutil
import statistics
import sys
import tempfile
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from ml.depth import MODEL_FILENAME, MODEL_ID, estimate_depth, load_session, quantise
from PIL import Image

FIXED = (518, 518)
WARMUPS = 2
RUNS = 10
DIFF_GAIN = 8
REGISTRY = Path(__file__).resolve().parents[2] / "src-tauri" / "src" / "models.rs"
DEFAULT_HOME = Path.home() / ".cache" / "oblique-bench"


# ---- the model file ----


def registry_entry() -> dict[str, Any]:
    """URL, SHA-256 and size of the depth model, from the Rust registry."""
    text = REGISTRY.read_text()
    block = text[text.index(f'id: "{MODEL_ID}"') :]
    try:
        return {
            "url": re.search(r'url:\s*"([^"]+)"', block).group(1),
            "sha256": re.search(r'sha256:\s*"([0-9a-f]{64})"', block).group(1),
            "size": int(
                re.search(r"size:\s*([0-9_]+)", block).group(1).replace("_", "")
            ),
        }
    except AttributeError as exc:
        raise SystemExit(
            f"could not read the {MODEL_ID} entry from {REGISTRY}"
        ) from exc


def ensure_model(model_dir: Path) -> Path:
    path = model_dir / MODEL_FILENAME
    if path.is_file():
        return path
    entry = registry_entry()
    model_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"downloading {entry['url']}\n  -> {path} ({entry['size']:,} bytes)", flush=True
    )
    part = path.with_suffix(".part")
    digest = hashlib.sha256()
    with urllib.request.urlopen(entry["url"]) as response, part.open("wb") as out:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    if part.stat().st_size != entry["size"] or digest.hexdigest() != entry["sha256"]:
        part.unlink()
        raise SystemExit("the download does not match the registry's size and SHA-256")
    part.rename(path)
    return path


# ---- the inputs ----


def make_inputs(image_path: Path) -> dict[str, np.ndarray]:
    """Three RGBA rasters from one photo: 2048 px, 4096 px (long side) and a 2048 px cut-out."""
    photo = Image.open(image_path).convert("RGBA")

    def at(long_side: int) -> Image.Image:
        scale = long_side / max(photo.size)
        size = (max(1, round(photo.width * scale)), max(1, round(photo.height * scale)))
        return photo.resize(size, Image.LANCZOS)

    small = np.array(at(2048))
    large = np.array(at(4096))
    cut = small.copy()
    height, width = cut.shape[:2]
    yy, xx = np.mgrid[0:height, 0:width]
    inside = ((xx - width / 2) / (width * 0.38)) ** 2 + (
        (yy - height / 2) / (height * 0.42)
    ) ** 2 <= 1
    cut[..., 3] = np.where(inside, 255, 0).astype(np.uint8)
    if max(photo.size) < 2048:
        print(
            f"note: the photo is {photo.size}, so the 2048 and 4096 inputs are upscaled"
        )
    return {"2048": small, "4096": large, "cutout": cut}


# ---- one configuration ----


class Config:
    """One provider configuration. `fixed`: a fixed 518 x 518 input, with the session's free
    dimensions pinned. `cache`: CoreML's ModelCacheDirectory, so it is opened twice, to time
    the reload."""

    def __init__(
        self, name: str, providers: list[Any], fixed: bool, cache: bool = False
    ) -> None:
        self.name = name
        self.providers = providers
        self.fixed = fixed
        self.cache = cache


def configs(cache_dir: Path | None = None) -> list[Config]:
    cpu = ["CPUExecutionProvider"]
    out = [Config("cpu_shipped", cpu, fixed=False), Config("cpu_518", cpu, fixed=True)]
    for model_format in ("MLProgram", "NeuralNetwork"):
        for units in ("ALL", "CPUAndGPU"):
            options = {"ModelFormat": model_format, "MLComputeUnits": units}
            out.append(
                Config(
                    f"coreml_{model_format.lower()}_{units.lower()}",
                    [("CoreMLExecutionProvider", options)],
                    fixed=True,
                )
            )
    if cache_dir is not None:
        options = {
            "ModelFormat": "MLProgram",
            "MLComputeUnits": "ALL",
            "ModelCacheDirectory": str(cache_dir),
        }
        out.append(
            Config(
                "coreml_mlprogram_all_cached",
                [("CoreMLExecutionProvider", options)],
                fixed=True,
                cache=True,
            )
        )
    return out


@contextlib.contextmanager
def captured_stderr() -> Iterator[list[str]]:
    """onnxruntime's C++ logger writes to file descriptor 2, which `sys.stderr` does not see."""
    lines: list[str] = []
    sys.stderr.flush()
    saved = os.dup(2)
    with tempfile.TemporaryFile(mode="w+b") as sink:
        os.dup2(sink.fileno(), 2)
        try:
            yield lines
        finally:
            os.dup2(saved, 2)
            os.close(saved)
            sink.seek(0)
            lines.extend(sink.read().decode("utf-8", "replace").splitlines())


COVERAGE = re.compile(
    r"number of partitions supported by CoreML: (\d+) number of nodes in the graph: (\d+) "
    r"number of nodes supported by CoreML: (\d+)"
)


def coverage(lines: list[str]) -> str:
    for line in lines:
        found = COVERAGE.search(line)
        if found:
            partitions, total, taken = (int(g) for g in found.groups())
            return f"{taken}/{total} nodes ({100 * taken / total:.0f}%) in {partitions} partitions"
    return "not in the log"


def open_session(config: Config) -> tuple[Any, float, str]:
    """(session, load seconds, coverage line). CoreML's coverage comes from the verbose log."""
    options = ort.SessionOptions()
    if config.fixed:
        options.add_free_dimension_override_by_name("batch_size", 1)
        options.add_free_dimension_override_by_name("height", FIXED[0])
        options.add_free_dimension_override_by_name("width", FIXED[1])
    options.log_severity_level = 0  # verbose, for the node count
    with captured_stderr() as lines:
        started = time.perf_counter()
        session = load_session(MODEL_PATH, config.providers, options)
        load = time.perf_counter() - started
    note = coverage(lines) if config.name.startswith("coreml") else "n/a (CPU)"
    return session, load, note


def median_ms(session: Any, rgba: np.ndarray, size: tuple[int, int] | None) -> float:
    for _ in range(WARMUPS):
        estimate_depth(session, rgba, input_size=size)
    times = []
    for _ in range(RUNS):
        started = time.perf_counter()
        estimate_depth(session, rgba, input_size=size)
        times.append((time.perf_counter() - started) * 1000)
    return statistics.median(times)


def grey_png(grey: np.ndarray, alpha: np.ndarray, path: Path) -> None:
    Image.fromarray(np.stack([grey, alpha], axis=-1), "LA").save(path)


MODEL_PATH = Path()


def main() -> None:
    global MODEL_PATH
    parser = argparse.ArgumentParser(
        description="CPU against CoreML for the depth model"
    )
    parser.add_argument(
        "image",
        type=Path,
        help="a photo; the 2048, 4096 and cut-out inputs are made from it",
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=DEFAULT_HOME / MODEL_ID,
        help=f"folder holding {MODEL_FILENAME}; downloaded there when missing "
        f"(default {DEFAULT_HOME / MODEL_ID})",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_HOME / "depth-out",
        help="where the PNGs go (default %(default)s)",
    )
    args = parser.parse_args()

    MODEL_PATH = ensure_model(args.model_dir)
    args.out.mkdir(parents=True, exist_ok=True)
    inputs = make_inputs(args.image)
    print(f"onnxruntime {ort.__version__}, providers {ort.get_available_providers()}")
    print(
        f"warm-ups {WARMUPS}, median of {RUNS}, ms end to end (resize, model, resize back)\n"
    )

    maps: dict[tuple[str, str], np.ndarray] = {}  # (config, input) -> 8-bit grey
    rows: list[str] = []
    cache_dir = args.out / "coreml-cache"
    shutil.rmtree(
        cache_dir, ignore_errors=True
    )  # so the first open of the cached config compiles
    all_configs = configs(cache_dir)
    for config in all_configs:
        print(f"[{config.name}]", flush=True)
        try:
            session, load, note = open_session(config)
            if config.cache:
                print(
                    f"  first load {load:.2f} s (compiles and fills the cache)",
                    flush=True,
                )
                session, load, note = open_session(config)
                print(f"  second load {load:.2f} s (from the cache)", flush=True)
        except Exception as exc:  # noqa: BLE001 - a provider that won't load is a result
            print(f"  could not load: {exc}\n")
            rows.append(f"{config.name:<34} could not load")
            continue
        size = FIXED if config.fixed else None
        print(f"  load {load:.2f} s   coverage: {note}", flush=True)
        speeds = {}
        for label, rgba in inputs.items():
            speeds[label] = median_ms(session, rgba, size)
            maps[(config.name, label)] = quantise(
                estimate_depth(session, rgba, input_size=size), 8
            )
            grey_png(
                maps[(config.name, label)],
                rgba[..., 3],
                args.out / f"{label}_{config.name}.png",
            )
            print(f"  {label:<7} {speeds[label]:8.1f} ms", flush=True)
        rows.append(
            f"{config.name:<34} load {load:6.2f} s  "
            + "  ".join(f"{label} {ms:7.1f} ms" for label, ms in speeds.items())
        )
        print()

    print(
        f"sameness: 8-bit levels over the visible pixels (max / mean); diff PNGs are x{DIFF_GAIN}"
    )
    for config in all_configs:
        if not config.name.startswith("coreml"):
            continue
        for label, rgba in inputs.items():
            ours = maps.get((config.name, label))
            if ours is None:
                continue
            visible = rgba[..., 3] > 0
            line = f"  {config.name:<34} {label:<7}"
            for reference in ("cpu_518", "cpu_shipped"):
                ref = maps.get((reference, label))
                if ref is None:
                    continue
                diff = np.abs(ours.astype(np.int16) - ref.astype(np.int16))
                line += f"  vs {reference}: {diff[visible].max()} / {diff[visible].mean():.2f}"
                suffix = "diff" if reference == "cpu_518" else "diff_vs_shipped"
                grey_png(
                    np.clip(diff * DIFF_GAIN, 0, 255).astype(np.uint8),
                    rgba[..., 3],
                    args.out / f"{label}_{config.name}_{suffix}.png",
                )
            print(line)

    print("\nsummary")
    for row in rows:
        print(" ", row)
    print(f"\nPNGs in {args.out}")


if __name__ == "__main__":
    main()
