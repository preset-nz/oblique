"""MobileSAM plumbing for the `segment` control message: weight fetch
(`fetch.py`), lazy onnxruntime sessions + embedding cache (`session.py`),
and mask -> polygon tracing (`trace.py`). See `handlers/segment.py` for the
request/response shape.

`colour.py` (Epic 17 story 2b, colour-range-select.md) is the magic wand's
algorithm — no model, no weights, pure NumPy — sharing only `trace.py` with
`segment`. See `handlers/select_colour.py`.
"""
