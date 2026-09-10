"""MobileSAM plumbing for the `segment` control message: weight fetch
(`fetch.py`), lazy onnxruntime sessions + embedding cache (`session.py`),
and mask -> polygon tracing (`trace.py`). See `handlers/segment.py` for the
request/response shape.
"""
