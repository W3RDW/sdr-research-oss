"""Verify an off-bin CW carrier reaches a WAV and decodes through the real DSP."""

import os
import sys
import tempfile
import time
import types
from pathlib import Path

import numpy as np
from gnuradio import analog, blocks, gr

source_path = Path(sys.argv[1])
decoder_path = Path(sys.argv[2])
output_dir = tempfile.mkdtemp(prefix="sdr-cw-smoke-")
rate = 2400000
os.environ.update(
    OSMOSDR_ARGS="test", SAMPLE_RATE=str(rate), DWELL_CENTER_HZ="7650000",
    FIXED_MONITOR_HZ="7030000", FIXED_MONITOR_ENABLED="false",
    NUM_DYN_FM="0", NUM_DYN_CW="2", NUM_DYN_ACARS="0", FFT_SIZE="16384",
    FFT_INTERVAL="0.2", CW_RECORD_BANDS_HZ="7000000-7125000", FM_RECORD_BANDS_HZ="",
    RF_SQUELCH_DB="-40", AUTO_SQUELCH_MIN_DB="-90", AUTO_SQUELCH_MARGIN_DB="6",
    SQUELCH_OPEN_DB="-55", SQUELCH_CLOSE_DB="-60", CAPTURE_ID="cw-test",
    CAPTURE_SOURCE="synthetic-cw", TAIL_SEC="1.5",
)


class Source(gr.hier_block2):
    def __init__(self, *args, **kwargs):
        gr.hier_block2.__init__(self, "CW test source", gr.io_signature(0, 0, 0),
                               gr.io_signature(1, 1, gr.sizeof_gr_complex))
        # CQ at 20 WPM; only the low-rate key envelope is stored in memory.
        dits = []
        for letter in ("-.-.", "--.-"):
            for symbol in letter:
                dits.extend([1] * (3 if symbol == "-" else 1) + [0])
            dits.extend([0] * 2)
        dits.extend([0] * 4)
        envelope = np.repeat(np.array(dits, dtype=np.float32), 480)
        self.keys = blocks.vector_source_f(envelope.tolist(), True)
        self.repeat = blocks.repeat(gr.sizeof_float, rate // 8000)
        self.complex_keys = blocks.float_to_complex()
        self.tone = analog.sig_source_c(rate, analog.GR_COS_WAVE, -619860, 0.15)
        self.multiply = blocks.multiply_cc()
        self.throttle = blocks.throttle(gr.sizeof_gr_complex, rate, True)
        self.connect(self.keys, self.repeat, self.complex_keys, (self.multiply, 0))
        self.connect(self.tone, (self.multiply, 1))
        self.connect(self.multiply, self.throttle, self)

    def set_sample_rate(self, *args): pass
    def set_center_freq(self, *args): pass
    def set_gain_mode(self, *args): pass
    def set_gain(self, *args): pass
    def set_freq_corr(self, *args): pass


sys.modules["osmosdr"] = types.SimpleNamespace(source=Source)
sys.path.insert(0, str(source_path.parent))
ns = {"__name__": "cw_capture_test"}
exec(compile(source_path.read_text().replace('"/data/', '"' + output_dir + '/'),
             str(source_path), "exec"), ns)
tb = ns["UnifiedSDR"]()
tb.start()
ns["FFTDetector"](tb).start()
ns["AutoSquelch"](tb).start()
time.sleep(12)
tb.stop()
tb.wait()
tb.close_all_recordings()
decoder = {"__name__": "cw_decode_test"}
exec(compile(decoder_path.read_text(), str(decoder_path), "exec"), decoder)
files = list((Path(output_dir) / "audio/cw").glob("*.wav"))
results = [(p.name, decoder["decode_file"](str(p))) for p in files]
print("OFF-BIN CW RESULTS:", results)
assert any(text and "CQ" in text for _, text in results), results
assert not list((Path(output_dir) / "audio/voice").glob("*.wav"))
print("PASS: 2.4 MS/s off-bin CW capture, disabled FM monitor, decoded CQ")
