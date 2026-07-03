"""Request handlers for multi-field ops (anything beyond a bare op lookup).

`ping` and `list_ops` are simple enough to live inline in `main.py`; `cook`
gets its own module because it owns payload decode/encode and the
modifier-stack fold.
"""
