"""Exercise the RTL TCP source through the real GNU Radio scheduler, without USB."""

import socket
import struct
import sys
import threading
from pathlib import Path

import numpy as np
from gnuradio import blocks, gr

sys.path.insert(0, str(Path(sys.argv[1]).parent))
from rtl_tcp_source import RTLTCPSource


for tuner in (5, 6):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    commands = []
    payload = np.arange(131074, dtype=np.uint8).tobytes()

    def serve():
        conn, _ = listener.accept()
        with conn:
            conn.sendall(struct.pack(">4sII", b"RTL0", tuner, 29))
            command_bytes = b""
            while len(command_bytes) < 8 * 5:
                command_bytes += conn.recv(8 * 5 - len(command_bytes))
            commands.extend(struct.iter_unpack(">BI", command_bytes))
            # Force a split inside one IQ sample.
            conn.sendall(payload[:1])
            conn.sendall(payload[1:])

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    source = RTLTCPSource("127.0.0.1", listener.getsockname()[1])
    source.set_sample_rate(2400000)
    source.set_center_freq(443500000)
    source.set_gain_mode(False)
    source.set_gain(40)
    source.set_freq_corr(-2)
    sink = blocks.vector_sink_c()
    tb = gr.top_block()
    tb.connect(source, sink)
    tb.run()
    server.join(timeout=5)
    assert not server.is_alive()
    assert (4, 402) in commands, commands
    assert (5, 0xFFFFFFFE) in commands, commands
    expected = ((np.frombuffer(payload, dtype=np.uint8).astype(np.float32) - 127.5) / 128).view(np.complex64)
    np.testing.assert_array_equal(sink.data(), expected)
    listener.close()
    print(f"PASS tuner={tuner}: actual scheduler, gain402, signed correction, {len(expected)} IQ samples")
