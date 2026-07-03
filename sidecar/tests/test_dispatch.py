from main import VERSION, dispatch
from ops import OPS, ParamSpec, op


def test_ping_reports_version():
    header, payload = dispatch({"id": "1", "op": "ping"}, b"")

    assert header == {"id": "1", "ok": True, "version": VERSION}
    assert payload == b""


def test_list_ops_includes_debug_echo():
    header, payload = dispatch({"id": "2", "op": "list_ops"}, b"")

    assert header["ok"] is True
    names = [o["name"] for o in header["ops"]]
    assert "debug_echo" in names
    debug_echo = next(o for o in header["ops"] if o["name"] == "debug_echo")
    assert debug_echo["backend"] == "python"
    assert payload == b""


def test_debug_echo_round_trips_payload():
    payload_in = bytes(range(256)) * 4
    header, payload_out = dispatch({"id": "3", "op": "debug_echo"}, payload_in)

    assert header == {"id": "3", "ok": True}
    assert payload_out == payload_in


def test_unknown_op_returns_ok_false():
    header, payload = dispatch({"id": "4", "op": "frobnicate"}, b"")

    assert header == {"id": "4", "ok": False, "error": "unknown op 'frobnicate'"}
    assert payload == b""


def test_handler_exception_returns_ok_false_with_error_and_keeps_registry_intact():
    @op("boom", [ParamSpec(name="x", type="float", default=0.0)])
    def _boom(payload: bytes, params: dict) -> bytes:
        raise ValueError("deliberate failure")

    try:
        header, payload = dispatch({"id": "5", "op": "boom"}, b"")

        assert header["id"] == "5"
        assert header["ok"] is False
        assert "deliberate failure" in header["error"]
        assert payload == b""
    finally:
        del OPS["boom"]
