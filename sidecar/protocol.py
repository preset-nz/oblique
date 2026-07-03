"""Framed stdio protocol for the Oblique sidecar.

Frame format (see guidance/projects/oblique/design/architecture.md
Section "Python sidecar protocol"):

    [4 bytes u32 LE: header_len] [header_len bytes: UTF-8 JSON header] [payload bytes]

The header always carries "payload_bytes" (0 if there is no payload).
"""

from __future__ import annotations

import json
import struct
import sys
from typing import BinaryIO

_HEADER_LEN_STRUCT = struct.Struct("<I")


def read_exact(stream: BinaryIO, n: int) -> bytes:
    """Read exactly `n` bytes from `stream`, looping over short reads.

    Pipes can return fewer bytes than requested per call. A zero-length
    read means EOF; if it happens before `n` bytes are collected, raise
    EOFError so callers can stop the loop cleanly.
    """
    chunks: list[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError(f"expected {n} bytes, got {n - remaining} before EOF")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stdin: BinaryIO) -> tuple[dict, bytes]:
    """Read one frame from `stdin`. Raises EOFError at a clean stream end."""
    header_len_bytes = read_exact(stdin, 4)
    (header_len,) = _HEADER_LEN_STRUCT.unpack(header_len_bytes)
    header_bytes = read_exact(stdin, header_len)
    header = json.loads(header_bytes.decode("utf-8"))
    payload_bytes = int(header.get("payload_bytes", 0))
    payload = read_exact(stdin, payload_bytes) if payload_bytes else b""
    return header, payload


def write_frame(stdout: BinaryIO, header: dict, payload: bytes = b"") -> None:
    """Write one frame to `stdout`. Sets payload_bytes on `header` and flushes."""
    header = {**header, "payload_bytes": len(payload)}
    header_bytes = json.dumps(header).encode("utf-8")
    stdout.write(_HEADER_LEN_STRUCT.pack(len(header_bytes)))
    stdout.write(header_bytes)
    if payload:
        stdout.write(payload)
    stdout.flush()


def stdin_buffer() -> BinaryIO:
    return sys.stdin.buffer


def stdout_buffer() -> BinaryIO:
    return sys.stdout.buffer
