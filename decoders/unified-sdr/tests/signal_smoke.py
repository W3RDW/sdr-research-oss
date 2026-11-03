"""Run a finite FM signal through the real GNU Radio capture pipeline.

Run inside the unified-sdr image: python3 signal_smoke.py /scripts/unified_sdr.py
No radio hardware is opened. Artifacts are isolated in a temporary directory.
"""

import os, sys, types, time, tempfile, wave, json
from pathlib import Path

source_path = Path(sys.argv[1])
output_dir = tempfile.mkdtemp(prefix="sdr-signal-smoke-")
import numpy as np
from gnuradio import gr, blocks

os.environ.update(
    OSMOSDR_ARGS="test",
    SAMPLE_RATE="240000",
    DWELL_CENTER_HZ="146000000",
    FIXED_MONITOR_HZ="146090000",
    NUM_DYN_FM="2",
    NUM_DYN_CW="0",
    NUM_DYN_ACARS="0",
    RF_SQUELCH_DB="-35",
    AUTO_SQUELCH_MIN_DB="-85",
    AUTO_SQUELCH_MARGIN_DB="6",
    FFT_INTERVAL="0.2",
    FFT_SIZE="4096",
    ENERGY_THRESH_DB="18",
    DIAGNOSTICS_ENABLED="true",
    AUTO_SQUELCH_INTERVAL_SEC="0.2",
    MIN_REC_SEC="0.5",
    CAPTURE_ID="synthetic",
    FM_RECORD_BANDS_HZ="146000000-148000000",
)


class Source(gr.hier_block2):
    def __init__(self, *a, **kw):
        gr.hier_block2.__init__(
            self,
            "test source",
            gr.io_signature(0, 0, 0),
            gr.io_signature(1, 1, gr.sizeof_gr_complex),
        )
        rate = 240000
        n = rate * 9
        t = np.arange(n) / rate
        rng = np.random.default_rng(99)
        noise = (rng.normal(size=n) + 1j * rng.normal(size=n)) * 0.0001
        signal = 0.01 * np.exp(
            1j * (2 * np.pi * 50000 * t + 0.75 * np.sin(2 * np.pi * 1000 * t))
        )
        signal[(t < 1) | (t > 7)] = 0
        self.v = blocks.vector_source_c(
            (noise + signal).astype(np.complex64).tolist(), False
        )
        self.th = blocks.throttle(gr.sizeof_gr_complex, rate)
        self.connect(self.v, self.th, self)

    def set_sample_rate(self, *a):
        pass

    def set_center_freq(self, *a):
        pass

    def set_gain_mode(self, *a):
        pass

    def set_gain(self, *a):
        pass

    def set_freq_corr(self, *a):
        pass


sys.modules["osmosdr"] = types.SimpleNamespace(source=Source)
sys.path.insert(0, str(source_path.parent))
ns = {"__name__": "capture_test"}
src = source_path.read_text().replace('"/data/', '"' + output_dir + "/")
exec(compile(src, "capture_test", "exec"), ns)
tb = ns["UnifiedSDR"]()
request = Path(tb.diagnostic.directory) / "request.json"
request.write_text(json.dumps({"frequency_hz": 146090000, "duration_seconds": 2}))
tb.start()
ns["FFTDetector"](tb).start()
ns["AutoSquelch"](tb).start()
time.sleep(10)
tb.stop()
tb.wait()
tb.close_all_recordings()
files = list((Path(output_dir) / "audio/voice").glob("*.wav"))
print("SYNTHETIC RECORDINGS:", [str(p) for p in files])
assert any(abs(int(p.name.split("_")[0]) - 146050000) < 2500 for p in files), (
    "Known FM signal was not recorded"
)
target = next(p for p in files if abs(int(p.name.split("_")[0]) - 146050000) < 2500)
with wave.open(str(target)) as wav:
    rate = wav.getframerate()
    samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    assert len(samples) / rate >= 5
    # Use the middle of the transmission, excluding gate transitions and tail.
    segment = samples[rate : rate * 3].astype(float)
    spectrum = abs(np.fft.rfft(segment * np.hanning(len(segment))))
    freqs = np.fft.rfftfreq(len(segment), 1 / rate)
    peak = freqs[np.argmax(spectrum)]
    assert abs(peak - 1000) < 5, f"Expected 1 kHz modulation, got {peak} Hz"
print("PASS: saved FM recording contains the expected 1 kHz tone", flush=True)
diagnostics = list(Path(tb.diagnostic.directory).glob("*.wav.json"))
assert len(diagnostics) == 1
metadata = json.loads(diagnostics[0].read_text())
assert metadata["before_squelch"] and metadata["duration_seconds"] == 2
print("PASS: bounded pre-squelch diagnostic completed in the same graph", flush=True)
os._exit(0)
