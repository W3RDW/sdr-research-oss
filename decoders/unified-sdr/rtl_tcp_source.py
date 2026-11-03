"""RTL TCP source with explicit gain support for both R820T and R828D tuners."""

import socket
import struct
import threading

import numpy as np
from gnuradio import gr


class RTLTCPSource(gr.sync_block):
    GAIN_TENTHS = (0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207,
                   229, 254, 280, 297, 328, 338, 364, 372, 386, 402, 421,
                   434, 439, 445, 480, 496)

    def __init__(self, host, port):
        gr.sync_block.__init__(self, name="RTL TCP", in_sig=None, out_sig=[np.complex64])
        self._socket = socket.create_connection((host, port), timeout=10)
        self._socket.settimeout(1)
        self._command_lock = threading.Lock()
        self._pending = b""
        try:
            header = b""
            while len(header) < 12:
                chunk = self._socket.recv(12 - len(header))
                if not chunk:
                    raise ConnectionError("RTL TCP disconnected during handshake")
                header += chunk
            magic, self.tuner_type, gains = struct.unpack(">4sII", header)
            if magic != b"RTL0" or self.tuner_type not in (5, 6) or gains != len(self.GAIN_TENTHS):
                raise RuntimeError(f"Unsupported RTL TCP header: {magic!r}, tuner={self.tuner_type}, gains={gains}")
            self._send(0x09, 0)
            self._send(0x0A, 0)
            print(f"[RTL TCP] tuner={self.tuner_type}, {gains} gains, {host}:{port}", flush=True)
        except Exception:
            self._socket.close()
            raise

    def _send(self, command, value):
        with self._command_lock:
            self._socket.sendall(struct.pack(">BI", command, int(value) & 0xFFFFFFFF))

    def set_sample_rate(self, rate):
        self._send(0x02, rate)

    def set_center_freq(self, frequency):
        self._send(0x01, frequency)

    def set_gain_mode(self, automatic):
        self._send(0x03, not automatic)
        self._send(0x08, automatic)

    def set_gain(self, gain):
        actual = min(self.GAIN_TENTHS, key=lambda value: abs(value - gain * 10))
        self._send(0x04, actual)
        print(f"[RTL TCP] requested gain={gain:.1f} dB, applied={actual / 10:.1f} dB", flush=True)
        return actual / 10

    def set_freq_corr(self, ppm):
        self._send(0x05, ppm)

    def work(self, input_items, output_items):
        output = output_items[0]
        try:
            data = self._socket.recv(len(output) * 2 - len(self._pending))
        except socket.timeout:
            return 0
        except OSError:
            return -1
        if not data:
            return -1
        data = self._pending + data
        count = len(data) // 2
        self._pending = data[count * 2:]
        iq = np.frombuffer(data, dtype=np.uint8, count=count * 2).astype(np.float32)
        iq -= 127.5
        iq /= 128.0
        output[:count] = iq.view(np.complex64)
        return count

    def stop(self):
        try:
            self._socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._socket.close()
        return True
