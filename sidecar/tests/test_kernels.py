"""Unit tests for `ops/_kernels.py` (Epic 19 story 1 — the kernels crate).

`test_available_is_true_by_default` is the no-silent-fallback test the epic
requires: if the `oblique_kernels` extension fails to import on this
machine, this test fails `just check` rather than every kernel-backed op
quietly running its NumPy fallback forever.
"""

from __future__ import annotations

import numpy as np
from ops import _kernels


def test_available_is_true_by_default():
    assert _kernels.available() is True


def test_canary_matches_times_two_exactly():
    kernels = _kernels.require()
    a = np.array([0.0, 1.0, -2.5, 3.25, 1e10], dtype=np.float32)

    out = kernels.canary(a)

    np.testing.assert_array_equal(out, a * 2)
    assert out.dtype == np.float32


def test_oblique_kernels_env_var_zero_disables_availability(monkeypatch):
    monkeypatch.setenv("OBLIQUE_KERNELS", "0")

    assert _kernels.available() is False


def test_available_reads_env_var_fresh_each_call(monkeypatch):
    assert _kernels.available() is True

    monkeypatch.setenv("OBLIQUE_KERNELS", "0")
    assert _kernels.available() is False

    monkeypatch.delenv("OBLIQUE_KERNELS")
    assert _kernels.available() is True
