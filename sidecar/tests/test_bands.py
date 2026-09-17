"""Unit tests for `ops/_bands.py` (epic 18, story 8) — the row-band thread
pool `hatch` opts into via `map_rows`. `hatch`'s own digest/equality tests
(`test_hatch.py`) cover the value-preserving contract end to end; these
tests cover `map_rows`/`worker_count` in isolation: band boundaries,
`worker_count` env parsing, and exception propagation. Story 9 caps the
unset-env fallback at 8 workers (the NumPy ceiling doc's scaling
measurement) — `test_worker_count_caps_the_unset_fallback_at_eight` is
the machine-independent guard for that.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from ops import _bands
from ops._bands import map_rows, worker_count


def test_map_rows_concatenates_bands_in_row_order(monkeypatch):
    monkeypatch.setattr(_bands, "worker_count", lambda: 4)

    def fn(y0, y1):
        return np.arange(y0, y1, dtype=np.int64)[:, None]

    out = map_rows(1000, fn, min_rows=100)

    np.testing.assert_array_equal(out[:, 0], np.arange(1000))


def test_map_rows_band_count_is_min_of_worker_count_and_ceil_height_over_min_rows(
    monkeypatch,
):
    monkeypatch.setattr(_bands, "worker_count", lambda: 3)
    calls: list[tuple[int, int]] = []

    def fn(y0, y1):
        calls.append((y0, y1))
        return np.zeros((y1 - y0, 1), dtype=np.float32)

    # ceil(1000 / 100) = 10, worker_count = 3 -> 3 bands, not 10.
    map_rows(1000, fn, min_rows=100)

    assert len(calls) == 3
    assert calls[0][0] == 0
    assert calls[-1][1] == 1000
    for (_, y1a), (y0b, _) in zip(calls, calls[1:]):
        assert y1a == y0b  # contiguous: no gap, no overlap


def test_map_rows_band_count_capped_by_ceil_height_over_min_rows(monkeypatch):
    monkeypatch.setattr(_bands, "worker_count", lambda: 18)
    calls: list[tuple[int, int]] = []

    def fn(y0, y1):
        calls.append((y0, y1))
        return np.zeros((y1 - y0, 1), dtype=np.float32)

    # ceil(1000 / 128) = 8, worker_count = 18 -> 8 bands, not 18.
    map_rows(1000, fn, min_rows=128)

    assert len(calls) == 8


def test_map_rows_direct_path_when_worker_count_is_one(monkeypatch):
    monkeypatch.setattr(_bands, "worker_count", lambda: 1)
    calls: list[tuple[int, int]] = []

    def fn(y0, y1):
        calls.append((y0, y1))
        return np.zeros((y1 - y0, 1), dtype=np.float32)

    map_rows(1000, fn, min_rows=100)

    assert calls == [(0, 1000)]


def test_map_rows_direct_path_when_height_below_two_min_rows(monkeypatch):
    monkeypatch.setattr(_bands, "worker_count", lambda: 8)
    calls: list[tuple[int, int]] = []

    def fn(y0, y1):
        calls.append((y0, y1))
        return np.zeros((y1 - y0, 1), dtype=np.float32)

    # 200 < 2 * 128 -> direct, even with 8 workers available.
    map_rows(200, fn, min_rows=128)

    assert calls == [(0, 200)]


def test_map_rows_handles_odd_heights(monkeypatch):
    monkeypatch.setattr(_bands, "worker_count", lambda: 4)

    def fn(y0, y1):
        return np.arange(y0, y1, dtype=np.int64)[:, None]

    out = map_rows(1031, fn, min_rows=100)

    np.testing.assert_array_equal(out[:, 0], np.arange(1031))


def test_map_rows_propagates_exceptions_from_a_band(monkeypatch):
    monkeypatch.setattr(_bands, "worker_count", lambda: 4)

    def fn(y0, y1):
        if y0 > 0:
            raise ValueError("boom")
        return np.zeros((y1 - y0, 1), dtype=np.float32)

    with pytest.raises(ValueError, match="boom"):
        map_rows(1000, fn, min_rows=100)


def test_worker_count_reads_env_var(monkeypatch):
    monkeypatch.setenv("OBLIQUE_SIDECAR_THREADS", "5")

    assert worker_count() == 5


def test_worker_count_falls_back_to_cpu_count_capped_at_eight_when_unset(monkeypatch):
    monkeypatch.delenv("OBLIQUE_SIDECAR_THREADS", raising=False)

    assert worker_count() == min(os.cpu_count() or 1, 8)


@pytest.mark.parametrize("raw", ("0", "-3", "not-a-number", ""))
def test_worker_count_ignores_non_positive_or_garbage_env_value(monkeypatch, raw):
    monkeypatch.setenv("OBLIQUE_SIDECAR_THREADS", raw)

    assert worker_count() == min(os.cpu_count() or 1, 8)


def test_worker_count_caps_the_unset_fallback_at_eight(monkeypatch):
    # Story 9: scaling stops at 8 threads (story 9 doc, "Why"), so the
    # fallback caps there regardless of how many cores the machine has —
    # machine-independent, unlike the two tests above on a <=8-core box.
    monkeypatch.delenv("OBLIQUE_SIDECAR_THREADS", raising=False)
    monkeypatch.setattr(os, "cpu_count", lambda: 18)

    assert worker_count() == 8
