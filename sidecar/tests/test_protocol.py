import io

import pytest
from protocol import read_exact, read_frame, write_frame


def test_write_then_read_frame_round_trip():
    stream = io.BytesIO()
    write_frame(stream, {"id": "abc", "ok": True}, b"hello")
    stream.seek(0)

    header, payload = read_frame(stream)

    assert header == {"id": "abc", "ok": True, "payload_bytes": 5}
    assert payload == b"hello"


def test_round_trip_with_no_payload():
    stream = io.BytesIO()
    write_frame(stream, {"id": "1", "ok": True})
    stream.seek(0)

    header, payload = read_frame(stream)

    assert header["payload_bytes"] == 0
    assert payload == b""


def test_round_trip_large_payload():
    payload = bytes(i % 256 for i in range(10 * 1024 * 1024))
    stream = io.BytesIO()
    write_frame(stream, {"id": "big", "ok": True}, payload)
    stream.seek(0)

    header, out_payload = read_frame(stream)

    assert header["payload_bytes"] == len(payload)
    assert out_payload == payload


def test_read_exact_loops_over_short_reads():
    class ShortReadStream:
        """Simulates a pipe that only ever returns a few bytes per read()."""

        def __init__(self, data: bytes, chunk_size: int):
            self._data = data
            self._chunk_size = chunk_size
            self._pos = 0

        def read(self, n: int) -> bytes:
            end = min(self._pos + min(n, self._chunk_size), len(self._data))
            chunk = self._data[self._pos : end]
            self._pos = end
            return chunk

    data = bytes(range(256)) * 40  # 10240 bytes
    stream = ShortReadStream(data, chunk_size=3)

    result = read_exact(stream, len(data))

    assert result == data


def test_read_exact_raises_eof_on_early_stream_end():
    stream = io.BytesIO(b"short")

    with pytest.raises(EOFError):
        read_exact(stream, 100)


def test_read_frame_raises_eof_at_clean_stream_end():
    stream = io.BytesIO(b"")

    with pytest.raises(EOFError):
        read_frame(stream)
