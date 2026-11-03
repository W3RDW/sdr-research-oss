"""Exercise real recorder state transitions without opening radio hardware."""

import ast
from collections import deque
import json
import math
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import wave

import numpy as np
import pytest


@pytest.fixture
def capture(tmp_path):
    path = Path(__file__).resolve().parents[2] / "decoders/unified-sdr/unified_sdr.py"
    nodes = [n for n in ast.parse(path.read_text()).body
             if isinstance(n, ast.ClassDef) and n.name in
             ("SquelchRecorder", "BoundedDiagnosticRecorder")]
    block = type("Block", (), {"__init__": lambda self, **kwargs: None})
    scope = dict(
        np=np, gr=SimpleNamespace(sync_block=block), deque=deque, os=os,
        wave=wave, time=time, math=math, json=json, threading=threading,
        SQUELCH_OPEN=-40, SQUELCH_CLOSE=-45, TAIL_SEC=0.02,
        MIN_REC_SEC=0.05, MAX_REC_SEC=120, FM_PCM_GAIN=10 ** (-6 / 20),
        FM_PREROLL_SEC=0.35, NOISE_DISCARD_RMS_DB=-9,
        ACTIVE_AUDIO_RMS=0.001, CAPTURE_ID="test", CAPTURE_SOURCE="test-airspy",
        CAPTURE_DEVICE_SERIAL="test-serial", SAMPLE_RATE=6000000,
        AUDIO_RATE_FM=1000, DIAGNOSTIC_ROOT=str(tmp_path / "diagnostics"),
    )
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), scope)  # noqa: S102
    return SimpleNamespace(**scope)


def feed(rec, audio, gate):
    audio = np.asarray(audio, dtype=np.float32)
    rec.work([audio, np.full(len(audio), gate, dtype=np.float32)], [])


def test_preroll_retains_leadin_and_headroom_prevents_pcm_clipping(capture, tmp_path):
    rec = capture.SquelchRecorder(146610000, 1000, str(tmp_path), rf_gated=True)
    feed(rec, [0.05] * 100, 0)
    assert list(tmp_path.glob("*.wav*")) == []
    speech = np.full(100, 0.05, dtype=np.float32)
    speech[50] = 1.8
    feed(rec, speech, 1)
    rec.close_if_recording()
    path = next(tmp_path.glob("*.wav"))
    with wave.open(str(path)) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    assert len(pcm) == 200
    assert np.allclose(pcm[:100] / 32767, 0.05 * rec.pcm_gain, atol=1 / 32767)
    assert pcm[150] / 32767 == pytest.approx(1.8 * rec.pcm_gain, abs=1 / 32767)
    assert np.max(abs(pcm)) < 32760
    metadata = json.loads(path.with_suffix(".capture.json").read_text())
    assert metadata["preroll_seconds"] == 0.1
    assert metadata["unscaled_active_rms_db"] == pytest.approx(
        10 * math.log10(float(np.mean(speech ** 2))), abs=0.001)


def test_headroom_and_quiet_preroll_do_not_defeat_noise_rejection(capture, tmp_path):
    rec = capture.SquelchRecorder(146610000, 1000, str(tmp_path), rf_gated=True)
    feed(rec, [0.001] * 350, 0)
    feed(rec, [0.5] * 100, 1)
    rec.close_if_recording()
    # Scaled audio would be -12 dB and pass a -9 dB threshold. Raw audio must fail.
    assert list(tmp_path.glob("*.wav*")) == []


def test_preroll_cannot_make_a_short_burst_meet_minimum_duration(capture, tmp_path):
    rec = capture.SquelchRecorder(146610000, 1000, str(tmp_path), rf_gated=True)
    feed(rec, [0.01] * 500, 0)
    assert rec._preroll_count == 350
    feed(rec, [0.1] * 10, 1)
    rec.close_if_recording()
    assert list(tmp_path.glob("*.wav*")) == []


def test_retune_discards_leadin_from_previous_frequency(capture, tmp_path):
    rec = capture.SquelchRecorder(146610000, 1000, str(tmp_path), rf_gated=True)
    feed(rec, [0.2] * 100, 0)
    rec.deactivate()
    rec.activate(146520000)
    feed(rec, [0.1] * 100, 1)
    rec.close_if_recording()
    path = next(tmp_path.glob("*.wav"))
    with wave.open(str(path)) as w:
        assert w.getnframes() == 100
    assert json.loads(path.with_suffix(".capture.json").read_text())["preroll_seconds"] == 0


def test_diagnostic_is_capped_and_preserves_closed_gate_audio(capture):
    rec = capture.BoundedDiagnosticRecorder(146610000, lambda: True)
    directory = Path(rec.directory)
    (directory / "request.json").write_text(json.dumps(
        {"frequency_hz": 146610000, "duration_seconds": 600}))
    audio = np.full(1000, 0.5, dtype=np.float32)
    power = np.full(1000, 1e-8, dtype=np.float32)
    for _ in range(31):
        rec.work([audio, power, np.zeros(1000, dtype=np.float32)], [])
    assert rec.wf is None
    path = next(directory.glob("*.wav"))
    with wave.open(str(path)) as w:
        assert w.getnframes() == 30000
        assert max(np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")) > 0
    meta = json.loads(Path(str(path) + ".json").read_text())
    assert meta["duration_seconds"] == 30
    assert meta["rf_mean_dbfs"] == pytest.approx(-80)
    assert meta["rf_gate_open_fraction"] == 0
    assert meta["before_squelch"]


def test_diagnostic_does_not_mislabel_retuned_audio(capture):
    tuned = [True]
    rec = capture.BoundedDiagnosticRecorder(146610000, lambda: tuned[0])
    directory = Path(rec.directory)
    (directory / "request.json").write_text(json.dumps(
        {"frequency_hz": 146610000, "duration_seconds": 10}))
    items = [np.ones(100, dtype=np.float32)] * 3
    rec.work(items, [])
    tuned[0] = False
    rec.work(items, [])
    path = next(directory.glob("*.wav.json"))
    meta = json.loads(path.read_text())
    assert meta["reason"] == "retuned"
    assert meta["duration_seconds"] == 0.1


@pytest.mark.parametrize("frequency,duration", [(146520000, 10), (146610000, -1),
                                               (146610000, "nan")])
def test_diagnostic_rejects_wrong_frequency_and_invalid_duration(capture, frequency, duration):
    rec = capture.BoundedDiagnosticRecorder(146610000, lambda: True)
    directory = Path(rec.directory)
    (directory / "request.json").write_text(json.dumps(
        {"frequency_hz": frequency, "duration_seconds": duration}))
    rec.work([np.ones(100, dtype=np.float32)] * 3, [])
    assert rec.wf is None
    assert not list(directory.glob("*.wav*"))
