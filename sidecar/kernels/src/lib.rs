//! `oblique_kernels` — native per-pixel kernels for the Oblique sidecar.
//!
//! Architecture decision 11a (`guidance/projects/oblique/design/architecture.md`
//! §"Native kernels inside the Python backend"): Python stays the op's home
//! — `@op` registration, param specs, tone/levels prep and output blend all
//! stay in `sidecar/ops/<op>.py`. This crate holds only fused, rayon-parallel
//! per-pixel loops, handed whatever Python already computed (tone maps,
//! trig scalars, offset lists) rather than re-deriving non-numeric logic.
//!
//! Byte-identity with the NumPy reference is the bar (decision 11a): plain
//! IEEE float32, no fast-math, no FMA contraction — see the crate's release
//! profile in `Cargo.toml`.
//!
//! `canary` is this layer's `debug_echo`: before any real kernel lands, it
//! proves the build, the Python import, the NumPy interop and the rayon
//! thread pool all work.

use numpy::{PyArray1, PyReadonlyArray1};
use pyo3::prelude::*;
use rayon::prelude::*;

/// The crate version (from `Cargo.toml`), importable from Python so the
/// availability check can report which kernel build is loaded.
#[pyfunction]
fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Canary kernel: `a * 2`, computed across a rayon thread pool with the GIL
/// released. Proves the build, the numpy interop and the thread pool —
/// nothing else; it is not a real op kernel.
#[pyfunction]
fn canary<'py>(
    py: Python<'py>,
    a: PyReadonlyArray1<'py, f32>,
) -> PyResult<Bound<'py, PyArray1<f32>>> {
    let slice = a.as_slice()?;
    let doubled: Vec<f32> = py.detach(|| slice.par_iter().map(|x| x * 2.0).collect());
    Ok(PyArray1::from_vec(py, doubled))
}

#[pymodule]
fn oblique_kernels(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(version, m)?)?;
    m.add_function(wrap_pyfunction!(canary, m)?)?;
    Ok(())
}
