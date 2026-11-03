import importlib.util
import socket
import struct
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest


@pytest.fixture
def rtl_source(monkeypatch):
    class Block:
        def __init__(self, **kwargs):
            pass

    monkeypatch.setitem(sys.modules, "gnuradio", SimpleNamespace(gr=SimpleNamespace(sync_block=Block)))
    path = Path(__file__).resolve().parents[2] / "decoders/unified-sdr/rtl_tcp_source.py"
    spec = importlib.util.spec_from_file_location("test_rtl_source", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client, peer = socket.socketpair()
    peer.settimeout(1)
    monkeypatch.setattr(module.socket, "create_connection", lambda *a, **kw: client)
    yield module.RTLTCPSource, peer
    client.close()
    peer.close()


@pytest.mark.parametrize("tuner", [5, 6])
def test_r820t_and_blog_v4_receive_actual_requested_gain(rtl_source, tuner):
    cls, peer = rtl_source
    peer.sendall(struct.pack(">4sII", b"RTL0", tuner, 29))
    source = cls("test", 1234)
    source.set_gain_mode(False)
    assert source.set_gain(40) == 40.2
    commands = b""
    while len(commands) < 25:
        commands += peer.recv(25 - len(commands))
    assert list(struct.iter_unpack(">BI", commands)) == [(9, 0), (10, 0), (3, 1), (8, 0), (4, 402)]


def test_iq_alignment_survives_odd_network_reads(rtl_source):
    cls, peer = rtl_source
    peer.sendall(struct.pack(">4sII", b"RTL0", 6, 29))
    source = cls("test", 1234)
    output = np.zeros(4, dtype=np.complex64)
    peer.sendall(bytes([0, 255, 127]))
    assert source.work([], [output]) == 1
    assert output[0] == complex(-127.5 / 128, 127.5 / 128)
    peer.sendall(bytes([128, 200, 100]))
    assert source.work([], [output]) == 2
    np.testing.assert_allclose(output[:2], [complex(-.5 / 128, .5 / 128), complex(72.5 / 128, -27.5 / 128)])
    peer.shutdown(socket.SHUT_WR)
    assert source.work([], [output]) == -1


def test_bad_handshake_is_rejected(rtl_source):
    cls, peer = rtl_source
    peer.sendall(struct.pack(">4sII", b"NOPE", 6, 29))
    with pytest.raises(RuntimeError, match="Unsupported RTL TCP header"):
        cls("test", 1234)
