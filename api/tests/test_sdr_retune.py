"""Exercise retuning without requiring a local GNU Radio installation."""

import ast
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


def test_retune_drops_stale_channels_and_frames_before_resuming_fixed_monitor():
    path = Path(__file__).resolve().parents[2] / "decoders/unified-sdr/unified_sdr.py"
    tree = ast.parse(path.read_text())
    cls = next(
        n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "UnifiedSDR"
    )
    method = next(
        n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "retune"
    )
    scope = {"time": time, "RF_SETTLE_SEC": 0.3, "DWELL_CENTER": 146000000,
             "FIXED_MONITOR_ENABLED": True}
    exec(compile(ast.Module(body=[method], type_ignores=[]), str(path), "exec"), scope)  # noqa: S102 - trusted repository AST
    events = Mock()
    tb = SimpleNamespace(
        _tune_lock=threading.RLock(),
        _state_lock=threading.Lock(),
        rec_fixed=events.fixed,
        deactivate_all_dynamic=events.clear,
        src=events.source,
        fft_sink=events.fft,
        fixed_sq_state={"floor": -60},
        fixed_freq=144390000,
    )
    scope["retune"](tb, 162000000)
    assert tb.current_center_hz == 162000000
    assert tb.settle_until > time.time()
    assert tb.fixed_sq_state == {}
    events.fixed.activate.assert_not_called()
    assert [c[0] for c in events.mock_calls] == [
        "fixed.deactivate",
        "clear",
        "source.set_center_freq",
        "fft.reset",
    ]
    scope["retune"](tb, 146000000)
    events.fixed.activate.assert_called_once_with(144390000)
    events.fixed.set_inhibit.assert_called_once_with(0.3)
    assert events.clear.call_count == 2


def test_detected_carrier_uses_spectral_noise_instead_of_signal_as_floor():
    path = Path(__file__).resolve().parents[2] / "decoders/unified-sdr/unified_sdr.py"
    tree = ast.parse(path.read_text())
    cls = next(
        n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "UnifiedSDR"
    )
    method = next(
        n
        for n in cls.body
        if isinstance(n, ast.FunctionDef) and n.name == "_assign_fm_slot"
    )
    scope = {
        "time": time,
        "frequency_matches": lambda a, b, c: a == b,
        "DYN_SLOT_FREQ_TOLERANCE_HZ": 2500,
        "route_voice_dir": lambda f: "/voice",
        "AUTO_SQUELCH_MARGIN_DB": 6,
        "AUTO_SQUELCH_MIN_DB": -85,
        "AUTO_SQUELCH_MAX_DB": -25,
        "os": __import__("os"),
    }
    exec(compile(ast.Module(body=[method], type_ignores=[]), str(path), "exec"), scope)  # noqa: S102 - trusted repository AST
    slot = {
        "freq": None,
        "idx": 0,
        "xlate": Mock(),
        "recorder": Mock(),
        "rf_squelch": Mock(),
        "sq_state": {},
    }
    tb = SimpleNamespace(dyn_fm=[slot], get_center_hz=lambda: 162000000)
    scope["_assign_fm_slot"](tb, 162550000, -70)
    assert slot["freq"] == 162550000
    assert slot["sq_state"]["floor"] == -70
    slot["rf_squelch"].set_threshold.assert_called_once_with(-64)
    slot["xlate"].set_center_freq.assert_called_once_with(550000)
