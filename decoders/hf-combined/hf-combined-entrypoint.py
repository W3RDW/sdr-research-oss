#!/usr/bin/env python3
"""Combined HF decoder — time-shares the RX888 SoapyRemote between HFDL and SSTV.

The RX888 SoapyRemote server only accepts one streaming client at a time.
This pod alternates between two phases:

  Phase 1 — HFDL (dumphfdl): monitors HFDL ground-station frequencies,
      writes decoded JSON frames to /data/text/hfdl/.

  Phase 2 — SSTV-HF (SoapySDR Python + slowrx-cli): cycles through HF SSTV
      frequencies, USB-demodulates audio, decodes images to /data/images/sstv/.

Both output paths are picked up automatically by the API indexer.
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
from typing import List

import numpy as np
from scipy import signal as sp_signal
from PIL import Image

# ── Shared config ─────────────────────────────────────────────────────────────
SOAPY_REMOTE = os.getenv(
    "SOAPY_REMOTE", "rx888-soapy.sdr-research.svc.cluster.local:55132"
)
SOAPY_DEVICE_STRING = os.getenv("SOAPY_DEVICE_STRING", "").strip()

# ── HFDL config ───────────────────────────────────────────────────────────────
HFDL_OUTPUT_DIR = os.getenv("HFDL_OUTPUT_DIR", "/data/text/hfdl")
HFDL_FREQUENCIES = os.getenv(
    "HFDL_FREQUENCIES", "8912 8927 10081 11384 13303"
).split()
HFDL_DWELL_SEC = int(os.getenv("HFDL_DWELL_SEC", "300"))  # 5 min default

# ── SSTV config ───────────────────────────────────────────────────────────────
SSTV_OUTPUT_DIR = os.getenv("SSTV_OUTPUT_DIR", "/data/images/sstv")
SSTV_FREQUENCIES: List[int] = [
    int(x) for x in
    os.getenv("HF_SSTV_FREQS", "14230000,21340000,28680000,7171000").split(",")
]
SSTV_SAMPLE_RATE = int(os.getenv("HF_SAMPLE_RATE", "2048000"))
SSTV_AUDIO_RATE = int(os.getenv("HF_AUDIO_RATE", "16000"))
SSTV_DWELL_SEC = int(os.getenv("HF_DWELL_SEC", "120"))
SSTV_GAIN = float(os.getenv("HF_GAIN", "20"))


def _soapysdr_device_string() -> str:
    if SOAPY_DEVICE_STRING:
        return SOAPY_DEVICE_STRING
    remote = SOAPY_REMOTE.strip()
    if remote.startswith("tcp://"):
        remote = remote[len("tcp://"):]
    return f"driver=remote,remote={remote},remote:driver=SDDC"


# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 1: HFDL
# ═══════════════════════════════════════════════════════════════════════════════

def _hfdl_reader(proc: subprocess.Popen) -> None:
    """Read JSON frames from dumphfdl stdout and write to PVC."""
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
            t = frame.get("t", {})
            freq = int(frame.get("freq", 0))
            ts_sec = t.get("sec", int(time.time()))
            ts_usec = t.get("usec", 0)
            ts_ms = ts_sec * 1000 + (ts_usec // 1000)
            filename = f"hfdl_{freq}_{ts_ms}.json"
            filepath = os.path.join(HFDL_OUTPUT_DIR, filename)
            with open(filepath, "w") as f:
                json.dump(frame, f)
            print(f"[HFDL] {filename}", flush=True)
        except (json.JSONDecodeError, KeyError, ValueError, OSError) as exc:
            print(f"[HFDL] Error: {exc}: {line[:100]}", flush=True)


def run_hfdl_phase() -> None:
    """Run dumphfdl for HFDL_DWELL_SEC, then gracefully stop it."""
    print(f"[HF] ═══ HFDL phase ({HFDL_DWELL_SEC}s) ═══", flush=True)

    cmd = [
        "dumphfdl",
        "--soapysdr", _soapysdr_device_string(),
        "--output", "decoded:json:file:path=-",
    ] + HFDL_FREQUENCIES

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, bufsize=1
    )

    reader = threading.Thread(target=_hfdl_reader, args=(proc,), daemon=True)
    reader.start()

    time.sleep(HFDL_DWELL_SEC)

    # Graceful shutdown — SIGTERM lets dumphfdl flush and close SoapyRemote
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    reader.join(timeout=5)

    print(f"[HF] HFDL phase complete (exit {proc.returncode})", flush=True)
    time.sleep(2)  # brief pause for SoapyRemote to release


# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 2: SSTV-HF
# ═══════════════════════════════════════════════════════════════════════════════

def _usb_demod(iq: np.ndarray, fs: int, audio_rate: int) -> np.ndarray:
    """Upper-sideband demodulation from complex baseband IQ samples."""
    n = len(iq)
    spec = np.fft.fft(iq)
    spec[n // 2:] = 0
    spec[0] = 0
    analytic = np.fft.ifft(spec)
    audio_full = np.real(analytic) * 2.0

    nyq = fs / 2
    sos = sp_signal.butter(5, [300 / nyq, 3000 / nyq], btype="bandpass", output="sos")
    audio_bp = sp_signal.sosfilt(sos, audio_full)

    decim = fs // audio_rate
    audio = sp_signal.decimate(audio_bp, decim, ftype="fir", zero_phase=True)
    return audio.astype(np.float32)


def _write_wav(audio: np.ndarray, path: str, rate: int) -> None:
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.9
    pcm = (audio * 32767).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())


def _decode_sstv(wav_path: str, freq_hz: int) -> None:
    ts_ms = int(time.time() * 1000)
    with tempfile.TemporaryDirectory() as tmp:
        bmp_path = os.path.join(tmp, "result.bmp")
        env = {**os.environ, "SDL_VIDEODRIVER": "offscreen", "SDL_AUDIODRIVER": "dummy"}
        subprocess.run(
            ["slowrx-cli", "-v", "-r", str(SSTV_AUDIO_RATE),
             "-o", bmp_path, wav_path],
            env=env, capture_output=True, text=True, timeout=300
        )
        if not os.path.exists(bmp_path):
            return
        dst = os.path.join(SSTV_OUTPUT_DIR, f"sstv_{freq_hz}_{ts_ms}.png")
        try:
            Image.open(bmp_path).save(dst, "PNG")
            print(f"[SSTV-HF] Decoded image @ {freq_hz/1e6:.3f} MHz → {os.path.basename(dst)}",
                  flush=True)
        except Exception as e:
            print(f"[SSTV-HF] BMP→PNG failed: {e}", flush=True)


def _capture_and_decode(sdr, freq_hz: int) -> None:
    import SoapySDR

    print(f"[SSTV-HF] Tuning to {freq_hz/1e6:.3f} MHz for {SSTV_DWELL_SEC}s", flush=True)
    sdr.setFrequency(SoapySDR.SOAPY_SDR_RX, 0, freq_hz)
    time.sleep(0.5)

    buf_size = 65536
    n_samples = SSTV_SAMPLE_RATE * SSTV_DWELL_SEC
    chunks: List[np.ndarray] = []
    total = 0

    rx_stream = sdr.setupStream(SoapySDR.SOAPY_SDR_RX, SoapySDR.SOAPY_SDR_CF32)
    sdr.activateStream(rx_stream)
    try:
        buf = np.zeros(buf_size, dtype=np.complex64)
        while total < n_samples:
            sr = sdr.readStream(rx_stream, [buf], buf_size, timeoutUs=1_000_000)
            if sr.ret > 0:
                chunks.append(buf[:sr.ret].copy())
                total += sr.ret
    finally:
        sdr.deactivateStream(rx_stream)
        sdr.closeStream(rx_stream)

    if not chunks:
        print(f"[SSTV-HF] No samples at {freq_hz/1e6:.3f} MHz", flush=True)
        return

    iq = np.concatenate(chunks)
    audio = _usb_demod(iq, SSTV_SAMPLE_RATE, SSTV_AUDIO_RATE)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
    try:
        _write_wav(audio, wav_path, SSTV_AUDIO_RATE)
        _decode_sstv(wav_path, freq_hz)
    finally:
        os.unlink(wav_path)


def run_sstv_phase() -> None:
    """Cycle through HF SSTV frequencies, capturing and decoding each."""
    total = SSTV_DWELL_SEC * len(SSTV_FREQUENCIES)
    print(f"[HF] ═══ SSTV phase ({total}s across {len(SSTV_FREQUENCIES)} freqs) ═══",
          flush=True)

    try:
        import SoapySDR
    except ImportError:
        print("[SSTV-HF] python3-soapysdr not available — skipping", flush=True)
        return

    try:
        sdr = SoapySDR.Device(_soapysdr_device_string())
        sdr.setSampleRate(SoapySDR.SOAPY_SDR_RX, 0, SSTV_SAMPLE_RATE)
        sdr.setGain(SoapySDR.SOAPY_SDR_RX, 0, SSTV_GAIN)
        print(f"[SSTV-HF] Connected to {_soapysdr_device_string()}", flush=True)

        for freq in SSTV_FREQUENCIES:
            _capture_and_decode(sdr, freq)

        # Explicitly release the SoapyRemote connection
        del sdr

    except Exception as e:
        print(f"[SSTV-HF] Error: {e}", flush=True)

    time.sleep(2)  # brief pause for SoapyRemote to release
    print(f"[HF] SSTV phase complete", flush=True)


# ═══════════════════════════════════════════════════════════════════════════════
#  Main loop
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    os.makedirs(HFDL_OUTPUT_DIR, exist_ok=True)
    os.makedirs(SSTV_OUTPUT_DIR, exist_ok=True)

    print(f"[HF] Combined HF decoder started", flush=True)
    print(f"[HF] Soapy device:    {_soapysdr_device_string()}", flush=True)
    print(f"[HF] HFDL freqs:     {' '.join(HFDL_FREQUENCIES)} kHz", flush=True)
    print(f"[HF] HFDL dwell:     {HFDL_DWELL_SEC}s", flush=True)
    print(f"[HF] SSTV freqs:     {[f'{f/1e6:.3f} MHz' for f in SSTV_FREQUENCIES]}", flush=True)
    print(f"[HF] SSTV dwell:     {SSTV_DWELL_SEC}s per freq", flush=True)

    while True:
        try:
            run_hfdl_phase()
            run_sstv_phase()
        except KeyboardInterrupt:
            print("[HF] Shutting down", flush=True)
            break
        except Exception as e:
            print(f"[HF] Unexpected error: {e} — retrying in 30s", flush=True)
            time.sleep(30)


if __name__ == "__main__":
    main()
