#!/usr/bin/env python3
"""FT8/WSPR decoder for sdr-research.

Captures audio from the RX888 MkII via SoapyRemote, runs jt9 (FT8/FT4)
and wsprd (WSPR) decoders, writes one JSON file per decoded spot to the
output directory.  The sdr-viewer API indexer picks these up as spots.

IMPORTANT: The RX888 SoapyRemote server only serves one client at a time.
Scale openwebrxplus to 0 while running this decoder.
  kubectl scale deploy openwebrxplus -n sdr-research --replicas=0
  kubectl scale deploy ft8-wspr-decoder -n sdr-research --replicas=1
"""

import json
import math
import os
import re
import select
import signal
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

try:
    import SoapySDR
except Exception:
    SoapySDR = None

# ---------------------------------------------------------------------------
# Configuration via env vars
# ---------------------------------------------------------------------------
SOAPY_REMOTE = os.getenv("SOAPY_REMOTE", "rx888-soapy.sdr-research.svc.cluster.local:55132")
SOAPY_DEVICE_ARGS = os.getenv("SOAPY_DEVICE_ARGS", "")
SOAPY_DEVICE_STRING = os.getenv("SOAPY_DEVICE_STRING", "").strip()
SOAPY_GAIN = float(os.getenv("SOAPY_GAIN", "20"))
SOAPY_RX_ANTENNA = os.getenv("SOAPY_RX_ANTENNA", "").strip()
OUTPUT_DIR = os.getenv("FT8_OUTPUT_DIR", "/data/text/ft8")
# RX888 MkII supports: 2/4/8/16/32/64 MSPS only (SDDC ADC constraint).
# Use minimum 2 MSPS and decimate in software to 12 kHz audio.
CAPTURE_RATE = int(os.getenv("CAPTURE_SAMPLE_RATE", "2000000"))
DECODE_DEPTH = int(os.getenv("DECODE_DEPTH", "3"))  # jt9 depth: 1=fast, 2=normal, 3=deep
CAPTURE_RETRIES = int(os.getenv("CAPTURE_RETRIES", "3"))
CAPTURE_RETRY_DELAY_SEC = float(os.getenv("CAPTURE_RETRY_DELAY_SEC", "2"))
FT8_CAPTURE_BACKEND = os.getenv("FT8_CAPTURE_BACKEND", "auto").strip().lower()

# FT8 dial frequencies (Hz) — standard worldwide allocations
FT8_FREQS = [int(f) for f in os.getenv("FT8_FREQUENCIES",
    "3573000 7074000 10136000 14074000 18100000 21074000 24915000 28074000"
).split()]

# WSPR dial frequencies (Hz)
WSPR_FREQS = [int(f) for f in os.getenv("WSPR_FREQUENCIES",
    "7038600 10138700 14095600 21094600 28124600"
).split()]

# How many FT8 bands to cycle before one WSPR capture
WSPR_EVERY_N = int(os.getenv("WSPR_EVERY_N", "6"))

# Station grid for distance calculation
STATION_GRID = os.getenv("STATION_GRID", "EM79")  # default ~Ohio/KY area

# SSTV capture — interleaved with FT8/WSPR
SSTV_FREQS = [int(f) for f in os.getenv("SSTV_FREQUENCIES", "").split() if f.strip()]
SSTV_EVERY_N = int(os.getenv("SSTV_EVERY_N", "12"))
SSTV_DWELL_SEC = int(os.getenv("SSTV_DWELL_SEC", "60"))
SSTV_OUTPUT_DIR = os.getenv("SSTV_OUTPUT_DIR", "/data/audio/voice")

# HFDL — runs dumphfdl subprocess (releases radio during capture)
HFDL_ENABLED = os.getenv("HFDL_ENABLED", "false").lower() in ("true", "1", "yes")
HFDL_FREQS = os.getenv("HFDL_FREQUENCIES", "10081 11384").split()
HFDL_DWELL_SEC = int(os.getenv("HFDL_DWELL_SEC", "120"))
HFDL_EVERY_N = int(os.getenv("HFDL_EVERY_N", "18"))
HFDL_OUTPUT_DIR = os.getenv("HFDL_OUTPUT_DIR", "/data/text/hfdl")
HFDL_SAMPLE_RATE = os.getenv("HFDL_SAMPLE_RATE", "2000000")
HFDL_CENTERFREQ = os.getenv("HFDL_CENTERFREQ", "10732.5")
HFDL_GAIN = os.getenv("HFDL_GAIN", "20")

SHUTDOWN = False
_CAPTURE_SESSION = None

# ---------------------------------------------------------------------------
# Maidenhead grid → lat/lon
# ---------------------------------------------------------------------------
def grid_to_latlon(grid: str):
    """Convert 4- or 6-char Maidenhead grid to center lat/lon."""
    grid = grid.strip().upper()
    if len(grid) < 4:
        return None, None
    try:
        lon = (ord(grid[0]) - ord('A')) * 20 - 180
        lat = (ord(grid[1]) - ord('A')) * 10 - 90
        lon += int(grid[2]) * 2
        lat += int(grid[3])
        if len(grid) >= 6:
            lon += (ord(grid[4]) - ord('A')) * (2 / 24)
            lat += (ord(grid[5]) - ord('A')) * (1 / 24)
            lon += 1 / 24
            lat += 0.5 / 24
        else:
            lon += 1
            lat += 0.5
        return round(lat, 4), round(lon, 4)
    except (IndexError, ValueError):
        return None, None


def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def freq_to_band(hz: int) -> str:
    """Map frequency in Hz to amateur band name."""
    mhz = hz / 1_000_000
    bands = [
        (1.8, 2.0, "160m"), (3.5, 4.0, "80m"), (5.3, 5.4, "60m"),
        (7.0, 7.3, "40m"), (10.1, 10.15, "30m"), (14.0, 14.35, "20m"),
        (18.068, 18.168, "17m"), (21.0, 21.45, "15m"),
        (24.89, 24.99, "12m"), (28.0, 29.7, "10m"),
    ]
    for lo, hi, name in bands:
        if lo <= mhz <= hi:
            return name
    return f"{mhz:.1f}MHz"


# ---------------------------------------------------------------------------
# Audio capture via rx_sdr (SoapySDR CLI tool)
# ---------------------------------------------------------------------------
TARGET_AUDIO_RATE = 12000  # jt9/wsprd expect 12 kHz mono WAV


def _soapysdr_device_string() -> str:
    if SOAPY_DEVICE_STRING:
        return SOAPY_DEVICE_STRING
    remote = SOAPY_REMOTE.strip()
    if remote.startswith("tcp://"):
        remote = remote[len("tcp://"):]
    device = f"driver=remote,remote={remote},remote:driver=SDDC,remote:format=CF32"
    if SOAPY_DEVICE_ARGS.strip():
        device += "," + SOAPY_DEVICE_ARGS.strip().lstrip(",")
    return device


class SoapyCaptureSession:
    """Long-lived Soapy session so we retune instead of reconnecting per band."""

    def __init__(self):
        import numpy as np
        from scipy.signal import decimate as scipy_decimate

        if SoapySDR is None:
            raise RuntimeError("SoapySDR Python bindings unavailable")

        self.np = np
        self.scipy_decimate = scipy_decimate
        self.device = SoapySDR.Device(_soapysdr_device_string())
        self.stream = self.device.setupStream(
            SoapySDR.SOAPY_SDR_RX,
            SoapySDR.SOAPY_SDR_CF32,
        )
        self.buffer = np.empty(CAPTURE_RATE, np.complex64)
        self.stage1_factor = max(1, CAPTURE_RATE // 48000)
        self.stage2_factor = 4
        self._active = False

    def close(self):
        if getattr(self, "stream", None) is None:
            return
        try:
            if self._active:
                self.device.deactivateStream(self.stream)
        except Exception:
            pass
        try:
            self.device.closeStream(self.stream)
        except Exception:
            pass
        self.stream = None
        self.device = None
        self._active = False

    def capture_audio(self, freq_hz: int, duration_sec: int, wav_path: str) -> bool:
        np = self.np

        n_samples = CAPTURE_RATE * duration_sec
        if SOAPY_RX_ANTENNA:
            self.device.setAntenna(SoapySDR.SOAPY_SDR_RX, 0, SOAPY_RX_ANTENNA)
        self.device.setSampleRate(SoapySDR.SOAPY_SDR_RX, 0, CAPTURE_RATE)
        self.device.setGain(SoapySDR.SOAPY_SDR_RX, 0, SOAPY_GAIN)
        self.device.setFrequency(SoapySDR.SOAPY_SDR_RX, 0, float(freq_hz + 1500))

        audio_chunks = []
        captured_samples = 0
        sample_offset = 0
        deadline = time.time() + duration_sec + 20
        iq_sumsq = 0.0     # Σ|iq|² across the whole capture (for RMS)
        iq_sum = 0 + 0j    # Σiq across the whole capture (for DC offset)
        iq_max = 0.0       # peak |iq|

        try:
            self.device.activateStream(self.stream)
            self._active = True
            self._flush_after_retune()

            while captured_samples < n_samples:
                elems = min(self.buffer.size, n_samples - captured_samples)
                status = self.device.readStream(
                    self.stream,
                    [self.buffer],
                    elems,
                    timeoutUs=5_000_000,
                )

                if status.ret > 0:
                    iq = np.array(self.buffer[:status.ret], copy=True)
                    iq_mag = np.abs(iq)
                    iq_sumsq += float(np.sum(iq_mag * iq_mag))
                    iq_sum += complex(np.sum(iq))
                    if len(iq_mag) > 0:
                        iq_max = max(iq_max, float(iq_mag.max()))
                    audio_chunk = self._iq_to_audio(iq, sample_offset)
                    if len(audio_chunk) > 0:
                        audio_chunks.append(audio_chunk)
                    captured_samples += status.ret
                    sample_offset += status.ret
                    continue

                if status.ret == SoapySDR.SOAPY_SDR_TIMEOUT and time.time() < deadline:
                    continue

                raise RuntimeError(f"readStream failed: {status.ret}")
        finally:
            try:
                self.device.deactivateStream(self.stream)
            except Exception:
                pass
            self._active = False

        if not audio_chunks:
            print("[CAPTURE] No audio produced from I/Q data", flush=True)
            return False

        audio = np.concatenate(audio_chunks)
        audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
        audio_rms = float(np.sqrt(np.mean(audio * audio))) if len(audio) > 0 else 0.0
        peak = float(np.max(np.abs(audio))) if len(audio) > 0 else 0.0
        if peak > 0:
            audio = audio / peak * 0.9

        audio_int16 = (audio * 32767).astype(np.int16)
        with wave.open(wav_path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(TARGET_AUDIO_RATE)
            wf.writeframes(audio_int16.tobytes())

        raw_size = captured_samples * 8
        iq_rms = (iq_sumsq / captured_samples) ** 0.5 if captured_samples else 0.0
        iq_dc = abs(iq_sum) / captured_samples if captured_samples else 0.0
        # iq_dc/iq_rms ratio > ~0.9 means the stream is mostly DC -> antenna
        # disconnected or RX888 stuck. Healthy RF has dc/rms well under 0.1.
        print(
            f"[CAPTURE] {raw_size/1e6:.0f} MB I/Q -> {len(audio_int16)} audio samples "
            f"({len(audio_int16)/TARGET_AUDIO_RATE:.1f}s @ {TARGET_AUDIO_RATE} Hz) "
            f"iq_rms={iq_rms:.4f} iq_dc={iq_dc:.4f} iq_peak={iq_max:.3f} "
            f"audio_rms={audio_rms:.4f} audio_peak={peak:.4f}",
            flush=True,
        )
        return True

    def _flush_after_retune(self):
        remaining = min(CAPTURE_RATE // 20, self.buffer.size)
        while remaining > 0:
            elems = min(self.buffer.size, remaining)
            status = self.device.readStream(
                self.stream,
                [self.buffer],
                elems,
                timeoutUs=100_000,
            )
            if status.ret <= 0:
                break
            remaining -= status.ret

    def _iq_to_audio(self, iq, sample_offset: int):
        np = self.np

        t = (sample_offset + np.arange(len(iq))) / CAPTURE_RATE
        audio_chunk = np.real(iq * np.exp(-2j * np.pi * (-1500) * t))

        if self.stage1_factor > 1 and len(audio_chunk) >= self.stage1_factor * 10:
            audio_chunk = self.scipy_decimate(audio_chunk, self.stage1_factor, ftype="fir")

        if self.stage2_factor > 1 and len(audio_chunk) >= self.stage2_factor * 10:
            audio_chunk = self.scipy_decimate(audio_chunk, self.stage2_factor, ftype="fir")

        return audio_chunk


def _get_capture_session():
    global _CAPTURE_SESSION
    if _CAPTURE_SESSION is None:
        _CAPTURE_SESSION = SoapyCaptureSession()
    return _CAPTURE_SESSION


def _close_capture_session():
    global _CAPTURE_SESSION
    if _CAPTURE_SESSION is not None:
        _CAPTURE_SESSION.close()
        _CAPTURE_SESSION = None


def _capture_audio_via_rx_sdr(freq_hz: int, duration_sec: int, wav_path: str) -> bool:
    """Fallback path when Python Soapy bindings are unavailable."""
    import numpy as np
    from scipy.signal import decimate as scipy_decimate

    raw_path = wav_path + ".raw"
    try:
        cmd = [
            "timeout",
            "-s", "INT",
            "-k", "2",
            str(duration_sec + 2),
            "rx_sdr",
            "-d", _soapysdr_device_string(),
            "-f", str(freq_hz + 1500),  # center on USB passband
            "-s", str(CAPTURE_RATE),
            "-g", str(SOAPY_GAIN),
            "-I", "CF32",  # SDDC only supports CF32 input
            "-F", "CF32",
            raw_path,
        ]
        proc = None
        for attempt in range(1, CAPTURE_RETRIES + 1):
            proc = subprocess.run(cmd, timeout=duration_sec + 60,
                                  capture_output=True, text=True)
            if proc.returncode in (0, 124, 130) and os.path.exists(raw_path):
                break
            print(f"[CAPTURE] rx_sdr attempt {attempt}/{CAPTURE_RETRIES} failed: "
                  f"{proc.stderr[:300]}", flush=True)
            if attempt < CAPTURE_RETRIES:
                time.sleep(CAPTURE_RETRY_DELAY_SEC)
        if proc is None or proc.returncode != 0:
            return False

        raw_size = os.path.getsize(raw_path)
        if raw_size < 1000:
            print(f"[CAPTURE] Raw file too small: {raw_size} bytes", flush=True)
            return False

        # Process in chunks to limit memory (~30 MB per chunk at 2 MSPS)
        # CF32 = interleaved float32 I,Q → 8 bytes per complex sample
        chunk_samples = CAPTURE_RATE  # 1 second per chunk
        chunk_bytes = chunk_samples * 8  # 8 bytes per CF32 sample

        # Multi-stage decimation from CAPTURE_RATE to TARGET_AUDIO_RATE
        # e.g. 2 MSPS → 12 kHz = factor ~166.67
        # Use two stages: first decimate by an integer factor to ~48 kHz,
        # then decimate to 12 kHz (factor 4).
        stage1_factor = CAPTURE_RATE // 48000  # e.g. 2000000/48000 ≈ 41
        stage2_factor = 4  # 48000 / 12000 = 4
        intermediate_rate = CAPTURE_RATE / stage1_factor

        all_audio = []
        with open(raw_path, "rb") as f:
            while True:
                data = f.read(chunk_bytes)
                if not data:
                    break
                # CF32: interleaved float32 I,Q
                raw_arr = np.frombuffer(data, dtype=np.float32)
                if len(raw_arr) < 4:
                    break
                iq = raw_arr[0::2] + 1j * raw_arr[1::2]

                # USB demodulation: mix down by -1500 Hz to center audio band
                t = np.arange(len(iq)) / CAPTURE_RATE
                audio_chunk = np.real(iq * np.exp(-2j * np.pi * (-1500) * t))

                # Stage 1: decimate to ~48 kHz
                if stage1_factor > 1 and len(audio_chunk) >= stage1_factor * 10:
                    audio_chunk = scipy_decimate(audio_chunk, stage1_factor, ftype='fir')

                # Stage 2: decimate to 12 kHz
                if stage2_factor > 1 and len(audio_chunk) >= stage2_factor * 10:
                    audio_chunk = scipy_decimate(audio_chunk, stage2_factor, ftype='fir')

                all_audio.append(audio_chunk)

        if not all_audio:
            print("[CAPTURE] No audio produced from I/Q data", flush=True)
            return False

        audio = np.concatenate(all_audio)
        audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)

        # Normalize
        peak = np.max(np.abs(audio))
        if peak > 0:
            audio = audio / peak * 0.9

        # Write WAV at 12 kHz mono 16-bit (what jt9/wsprd expect)
        audio_int16 = (audio * 32767).astype(np.int16)
        with wave.open(wav_path, 'w') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(TARGET_AUDIO_RATE)
            wf.writeframes(audio_int16.tobytes())

        print(f"[CAPTURE] {raw_size/1e6:.0f} MB I/Q → {len(audio_int16)} audio samples "
              f"({len(audio_int16)/TARGET_AUDIO_RATE:.1f}s @ {TARGET_AUDIO_RATE} Hz)", flush=True)
        return True
    except subprocess.TimeoutExpired:
        print(f"[CAPTURE] Timeout on {freq_hz} Hz", flush=True)
        return False
    except Exception as exc:
        print(f"[CAPTURE] Error: {exc}", flush=True)
        import traceback
        traceback.print_exc()
        return False
    finally:
        if os.path.exists(raw_path):
            os.unlink(raw_path)


def capture_audio(freq_hz: int, duration_sec: int, wav_path: str) -> bool:
    if FT8_CAPTURE_BACKEND == "rx_sdr" or SoapySDR is None:
        return _capture_audio_via_rx_sdr(freq_hz, duration_sec, wav_path)

    last_error = None
    for attempt in range(1, CAPTURE_RETRIES + 1):
        try:
            session = _get_capture_session()
            return session.capture_audio(freq_hz, duration_sec, wav_path)
        except Exception as exc:
            last_error = exc
            print(
                f"[CAPTURE] Soapy attempt {attempt}/{CAPTURE_RETRIES} failed: {exc}",
                flush=True,
            )
            import traceback
            traceback.print_exc()
            _close_capture_session()
            if attempt < CAPTURE_RETRIES:
                time.sleep(CAPTURE_RETRY_DELAY_SEC)

    print(f"[CAPTURE] Failed after {CAPTURE_RETRIES} attempts: {last_error}", flush=True)
    return False


# ---------------------------------------------------------------------------
# Decoders
# ---------------------------------------------------------------------------
def decode_ft8(wav_path: str, dial_hz: int) -> list[dict]:
    """Run jt9 --ft8 on a WAV file, parse stdout, return list of spot dicts."""
    spots = []
    try:
        result = subprocess.run(
            ["jt9", "--ft8", "-d", str(DECODE_DEPTH), "-p", "15", wav_path],
            capture_output=True, text=True, timeout=60,
        )
        for line in result.stdout.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            # jt9 output format:
            # HHMMSS  snr  dt  freq  message
            # 000000  -12  0.1  1234  CQ K1ABC FN42
            m = re.match(r"(\d{6})\s+(-?\d+)\s+(-?[\d.]+)\s+(\d+)\s+(.+)", line)
            if not m:
                continue
            ts_str, snr, dt, audio_freq, message = m.groups()
            callsign, grid = _extract_callsign_grid(message)
            tx_lat, tx_lon = grid_to_latlon(grid) if grid else (None, None)
            rx_lat, rx_lon = grid_to_latlon(STATION_GRID)
            dist = None
            if tx_lat is not None and rx_lat is not None:
                dist = round(haversine_km(rx_lat, rx_lon, tx_lat, tx_lon), 1)

            spots.append({
                "mode": "ft8",
                "dial_frequency_hz": dial_hz,
                "audio_offset_hz": int(audio_freq),
                "snr_db": int(snr),
                "dt": float(dt),
                "callsign": callsign,
                "grid": grid,
                "message": message.strip(),
                "band": freq_to_band(dial_hz),
                "distance_km": dist,
                "tx_latitude": tx_lat,
                "tx_longitude": tx_lon,
            })
    except subprocess.TimeoutExpired:
        print(f"[FT8] jt9 timed out on {wav_path}", flush=True)
    except Exception as exc:
        print(f"[FT8] decode error: {exc}", flush=True)
    return spots


def decode_wspr(wav_path: str, dial_hz: int) -> list[dict]:
    """Run wsprd on a WAV file, parse ALL_WSPR.TXT output."""
    spots = []
    workdir = os.path.dirname(wav_path)
    wspr_txt = os.path.join(workdir, "ALL_WSPR.TXT")
    # Remove stale output
    if os.path.exists(wspr_txt):
        os.unlink(wspr_txt)
    try:
        dial_mhz = dial_hz / 1_000_000
        subprocess.run(
            ["wsprd", "-f", f"{dial_mhz:.4f}", "-w", wav_path],
            capture_output=True, text=True, timeout=120, cwd=workdir,
        )
        if not os.path.exists(wspr_txt):
            return spots
        with open(wspr_txt) as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 7:
                    continue
                # Format: date time snr dt freq callsign grid power [drift]
                try:
                    snr = int(parts[2])
                    dt = float(parts[3])
                    freq_mhz = float(parts[4])
                    callsign = parts[5]
                    grid = parts[6] if len(parts) > 6 and len(parts[6]) >= 4 else None
                    power_dbm = int(parts[7]) if len(parts) > 7 else None
                    tx_lat, tx_lon = grid_to_latlon(grid) if grid else (None, None)
                    rx_lat, rx_lon = grid_to_latlon(STATION_GRID)
                    dist = None
                    if tx_lat is not None and rx_lat is not None:
                        dist = round(haversine_km(rx_lat, rx_lon, tx_lat, tx_lon), 1)

                    spots.append({
                        "mode": "wspr",
                        "dial_frequency_hz": dial_hz,
                        "audio_offset_hz": int((freq_mhz * 1e6) - dial_hz),
                        "snr_db": snr,
                        "dt": dt,
                        "callsign": callsign,
                        "grid": grid,
                        "power_dbm": power_dbm,
                        "message": f"{callsign} {grid or ''} {power_dbm or ''}".strip(),
                        "band": freq_to_band(dial_hz),
                        "distance_km": dist,
                        "tx_latitude": tx_lat,
                        "tx_longitude": tx_lon,
                    })
                except (ValueError, IndexError):
                    continue
    except subprocess.TimeoutExpired:
        print(f"[WSPR] wsprd timed out on {wav_path}", flush=True)
    except Exception as exc:
        print(f"[WSPR] decode error: {exc}", flush=True)
    return spots


def _extract_callsign_grid(message: str):
    """Extract primary callsign and grid from an FT8 message string."""
    parts = message.strip().split()
    callsign = None
    grid = None
    # FT8 messages: "CQ K1ABC FN42", "K1ABC W2XYZ FN31", "K1ABC W2XYZ R-10", etc.
    call_re = re.compile(r'^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$')
    grid_re = re.compile(r'^[A-R]{2}[0-9]{2}([A-X]{2})?$', re.IGNORECASE)
    for i, p in enumerate(parts):
        if p == "CQ" or p.startswith("CQ"):
            continue
        if call_re.match(p) and callsign is None:
            callsign = p
        elif call_re.match(p):
            callsign = p  # second callsign (the one being called) is usually more interesting
        if grid_re.match(p):
            grid = p
    return callsign, grid


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    global SHUTDOWN

    def _sig(signum, frame):
        global SHUTDOWN
        SHUTDOWN = True
        print(f"[FT8-WSPR] Received signal {signum}, shutting down…", flush=True)

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"[FT8-WSPR] Starting decoder", flush=True)
    print(f"[FT8-WSPR] SoapyRemote: {SOAPY_REMOTE}", flush=True)
    print(f"[FT8-WSPR] FT8 freqs:   {' '.join(str(f) for f in FT8_FREQS)}", flush=True)
    print(f"[FT8-WSPR] WSPR freqs:  {' '.join(str(f) for f in WSPR_FREQS)}", flush=True)
    print(f"[FT8-WSPR] Output dir:  {OUTPUT_DIR}", flush=True)
    print(f"[FT8-WSPR] Station grid: {STATION_GRID}", flush=True)

    ft8_idx = 0
    wspr_idx = 0
    sstv_idx = 0
    cycle_count = 0
    # Independent per-mode "cycles since last run" counters. Using a single
    # cycle_count + modulo silently starves any mode whose EVERY_N shares a
    # divisor with a higher-priority mode (e.g. SSTV_EVERY_N=12 was always
    # preempted by WSPR_EVERY_N=6 because every multiple of 12 is also a
    # multiple of 6, so SSTV NEVER ran). Tracking each mode independently
    # means a collision only delays the lower-priority mode by one cycle.
    cycles_since_wspr = 0
    cycles_since_sstv = 0
    cycles_since_hfdl = 0

    if SSTV_FREQS:
        print(f"[FT8-WSPR] SSTV freqs:  {' '.join(str(f) for f in SSTV_FREQS)} (every {SSTV_EVERY_N} cycles)", flush=True)
    if HFDL_ENABLED:
        print(f"[FT8-WSPR] HFDL freqs:  {' '.join(HFDL_FREQS)} kHz (every {HFDL_EVERY_N} cycles)", flush=True)

    try:
        with tempfile.TemporaryDirectory(prefix="ft8wspr_") as tmpdir:
            while not SHUTDOWN:
                now = datetime.now(timezone.utc)

                # Decide: FT8, WSPR, SSTV, or HFDL this cycle.
                # Priority: WSPR > SSTV > HFDL > FT8. Each mode increments
                # its own counter and runs when the counter reaches its
                # EVERY_N. The counter is only reset when the mode actually
                # runs, so a delayed mode is guaranteed to run on the next
                # non-conflicting cycle.
                do_wspr = (cycles_since_wspr >= WSPR_EVERY_N
                           and len(WSPR_FREQS) > 0)
                do_sstv = (not do_wspr
                           and cycles_since_sstv >= SSTV_EVERY_N
                           and len(SSTV_FREQS) > 0)
                do_hfdl = (not do_wspr and not do_sstv
                           and cycles_since_hfdl >= HFDL_EVERY_N
                           and HFDL_ENABLED and len(HFDL_FREQS) > 0)

                if do_hfdl:
                    # Release radio, run dumphfdl subprocess
                    _close_capture_session()
                    os.makedirs(HFDL_OUTPUT_DIR, exist_ok=True)
                    hfdl_cmd = [
                        "dumphfdl",
                        "--soapysdr", _soapysdr_device_string(),
                        "--sample-rate", HFDL_SAMPLE_RATE,
                        "--gain", HFDL_GAIN,
                    ]
                    if HFDL_CENTERFREQ:
                        hfdl_cmd += ["--centerfreq", HFDL_CENTERFREQ]
                    hfdl_cmd += ["--output", "decoded:json:file:path=-"] + HFDL_FREQS
                    print(f"[HFDL] Running dumphfdl for {HFDL_DWELL_SEC}s on {HFDL_FREQS}", flush=True)
                    try:
                        hfdl_proc = subprocess.Popen(
                            hfdl_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, bufsize=1)
                        hfdl_end = time.time() + HFDL_DWELL_SEC
                        hfdl_frames = 0
                        while time.time() < hfdl_end and not SHUTDOWN:
                            if select.select([hfdl_proc.stdout], [], [], 1.0)[0]:
                                line = hfdl_proc.stdout.readline().strip()
                                if not line:
                                    if hfdl_proc.poll() is not None:
                                        break
                                    continue
                                try:
                                    frame = json.loads(line)
                                    t = frame.get("t", {})
                                    freq_k = int(frame.get("freq", 0))
                                    ts_sec = t.get("sec", int(time.time()))
                                    ts_ms = ts_sec * 1000 + (t.get("usec", 0) // 1000)
                                    fname = f"hfdl_{freq_k}_{ts_ms}.json"
                                    with open(os.path.join(HFDL_OUTPUT_DIR, fname), "w") as hf:
                                        json.dump(frame, hf)
                                    hfdl_frames += 1
                                    print(f"[HFDL] {fname}", flush=True)
                                except Exception as he:
                                    print(f"[HFDL] Parse error: {he}", flush=True)
                        hfdl_proc.terminate()
                        hfdl_proc.wait(timeout=5)
                        print(f"[HFDL] Done — {hfdl_frames} frames decoded", flush=True)
                    except FileNotFoundError:
                        print("[HFDL] dumphfdl not found — skipping", flush=True)
                    except Exception as he:
                        print(f"[HFDL] Error: {he}", flush=True)
                    cycle_count += 1
                    cycles_since_wspr += 1
                    cycles_since_sstv += 1
                    cycles_since_hfdl = 0
                    continue

                if do_sstv:
                    freq = SSTV_FREQS[sstv_idx % len(SSTV_FREQS)]
                    sstv_idx += 1
                    mode = "sstv"
                    duration = SSTV_DWELL_SEC
                    print(f"[SSTV] Capturing {freq} Hz ({freq_to_band(freq)}) for {duration}s…",
                          flush=True)
                elif do_wspr:
                    freq = WSPR_FREQS[wspr_idx % len(WSPR_FREQS)]
                    wspr_idx += 1
                    mode = "wspr"
                    duration = 120  # 2-minute WSPR window

                    # WSPR transmissions begin at the top of every even UTC
                    # minute and run for 110.6s. wsprd needs the WAV to span
                    # one of those slots — capturing at an arbitrary phase
                    # yields zero decodes. Sleep until the next 2-min boundary
                    # before starting the capture.
                    now_ts = time.time()
                    wspr_wait = 120 - (now_ts % 120)
                    if wspr_wait > 0.5:
                        print(f"[WSPR] Waiting {wspr_wait:.1f}s for 2-min UTC boundary…",
                              flush=True)
                        time.sleep(wspr_wait)

                    print(f"[WSPR] Capturing {freq} Hz ({freq_to_band(freq)}) for {duration}s…",
                          flush=True)
                else:
                    freq = FT8_FREQS[ft8_idx % len(FT8_FREQS)]
                    ft8_idx += 1
                    mode = "ft8"
                    duration = 15  # 15-second FT8 window

                    # Align to 15-second boundary for proper FT8 decode
                    now_ts = time.time()
                    wait = 15 - (now_ts % 15)
                    if wait > 0.5:
                        time.sleep(wait)

                    print(f"[FT8] Capturing {freq} Hz ({freq_to_band(freq)}) for {duration}s…",
                          flush=True)

                wav_path = os.path.join(tmpdir, f"{mode}_{freq}_{int(time.time())}.wav")

                if not capture_audio(freq, duration, wav_path):
                    cycle_count += 1
                    time.sleep(2)
                    continue

                # Decode
                if mode == "sstv":
                    # Save WAV for sstv-decoder pod to process
                    os.makedirs(SSTV_OUTPUT_DIR, exist_ok=True)
                    dst = os.path.join(SSTV_OUTPUT_DIR, f"{freq}_{int(time.time())}.wav")
                    shutil.copy2(wav_path, dst)
                    print(f"[SSTV] Saved {os.path.basename(dst)} for decode", flush=True)
                    spots = []
                elif mode == "wspr":
                    spots = decode_wspr(wav_path, freq)
                else:
                    spots = decode_ft8(wav_path, freq)

                # Write each spot as a JSON file
                ts_ms = int(time.time() * 1000)
                for i, spot in enumerate(spots):
                    spot["timestamp"] = now.isoformat()
                    filename = f"{mode}_{freq}_{ts_ms}_{i}.json"
                    filepath = os.path.join(OUTPUT_DIR, filename)
                    try:
                        with open(filepath, "w") as f:
                            json.dump(spot, f)
                    except OSError as exc:
                        print(f"[FT8-WSPR] Write error: {exc}", flush=True)

                if spots:
                    print(f"[{mode.upper()}] {len(spots)} spots decoded on "
                          f"{freq_to_band(freq)}", flush=True)

                # Cleanup WAV
                if os.path.exists(wav_path):
                    os.unlink(wav_path)

                cycle_count += 1
                # Bump every counter, then zero the one whose mode just ran.
                # This is the "independent counters" half of the scheduler
                # fix described above.
                cycles_since_wspr += 1
                cycles_since_sstv += 1
                cycles_since_hfdl += 1
                if mode == "wspr":
                    cycles_since_wspr = 0
                elif mode == "sstv":
                    cycles_since_sstv = 0
                # HFDL uses its own continue branch above and won't reach
                # here, so its counter is reset in that branch directly.
    finally:
        _close_capture_session()

    print("[FT8-WSPR] Exiting.", flush=True)


if __name__ == "__main__":
    main()
