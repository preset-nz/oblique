"""MobileSAM plumbing for the `segment` control message: lazy onnxruntime
sessions + embedding cache + the model's file names (`session.py`), and
mask -> polygon tracing (`trace.py`). The weights are app-kit's, downloaded
by Rust; the sidecar only reads them. See `handlers/segment.py` for the
request/response shape.

`colour.py` (Epic 17 story 2b, colour-range-select.md) is the magic wand's
algorithm — no model, no weights, pure NumPy — sharing only `trace.py` with
`segment`. See `handlers/select_colour.py`.
"""
