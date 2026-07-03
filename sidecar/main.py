"""Oblique Python ops sidecar — long-lived framed-stdio loop.

Spawned and supervised by the Tauri app (see src-tauri/src/sidecar.rs).
Reads one frame at a time from stdin, dispatches on `header["op"]`, and
writes a response frame with the matching `id`. Never crashes on a bad
request: unknown ops and handler exceptions both produce `ok: false`
responses and the loop keeps serving.
"""

from __future__ import annotations

import sys
import traceback
from typing import Any

from ops import OPS
from protocol import read_frame, stdin_buffer, stdout_buffer, write_frame

VERSION = "0.1.0"


def handle_ping(header: dict[str, Any], payload: bytes) -> tuple[dict[str, Any], bytes]:
    return {"id": header["id"], "ok": True, "version": VERSION}, b""


def handle_list_ops(
    header: dict[str, Any], payload: bytes
) -> tuple[dict[str, Any], bytes]:
    ops = [op.to_dict() for op in OPS.values()]
    return {"id": header["id"], "ok": True, "ops": ops}, b""


def dispatch(header: dict[str, Any], payload: bytes) -> tuple[dict[str, Any], bytes]:
    op_name = header.get("op")

    if op_name == "ping":
        return handle_ping(header, payload)
    if op_name == "list_ops":
        return handle_list_ops(header, payload)

    op = OPS.get(op_name)
    if op is None:
        return {
            "id": header.get("id"),
            "ok": False,
            "error": f"unknown op '{op_name}'",
        }, b""

    try:
        result = op.fn(payload, header.get("params", {}))
    except Exception:  # noqa: BLE001 - per-request guard, must never crash the loop
        last_line = traceback.format_exc().strip().splitlines()[-1]
        return {"id": header.get("id"), "ok": False, "error": last_line}, b""

    return {"id": header["id"], "ok": True}, result


def main() -> None:
    stdin = stdin_buffer()
    stdout = stdout_buffer()

    while True:
        try:
            header, payload = read_frame(stdin)
        except EOFError:
            break

        try:
            response_header, response_payload = dispatch(header, payload)
        except Exception:  # noqa: BLE001 - per-request guard, must never crash the loop
            last_line = traceback.format_exc().strip().splitlines()[-1]
            response_header = {"id": header.get("id"), "ok": False, "error": last_line}
            response_payload = b""

        write_frame(stdout, response_header, response_payload)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
