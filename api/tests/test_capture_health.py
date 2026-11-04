"""Receiver recovery must depend on samples and surviving scan workers."""

import ast
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


@pytest.fixture
def capture_health():
    path = Path(__file__).resolve().parents[2] / "decoders/unified-sdr/unified_sdr.py"
    tree = ast.parse(path.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "CaptureHealth")
    clock = SimpleNamespace(monotonic=Mock(return_value=100), time=Mock(return_value=1000))
    scope = {"time": clock, "threading": threading}
    exec(compile(ast.Module(body=[cls], type_ignores=[]), str(path), "exec"), scope)  # noqa: S102
    return scope["CaptureHealth"](), clock


def test_receiver_that_never_samples_expires_after_startup_grace(capture_health):
    health, clock = capture_health
    assert health.snapshot([]) == (0, 0, None)
    clock.monotonic.return_value = 146
    assert "No fresh FFT samples" in health.snapshot([])[2]


def test_fresh_samples_keep_quiet_receiver_healthy(capture_health):
    health, clock = capture_health
    clock.monotonic.return_value = 200
    health.mark_samples()
    clock.monotonic.return_value = 205
    worker = SimpleNamespace(name="scanner", is_alive=lambda: True)
    assert health.snapshot([worker]) == (1000, 5, None)


def test_dead_scan_thread_fails_even_with_fresh_samples(capture_health):
    health, _ = capture_health
    health.mark_samples()
    worker = SimpleNamespace(name="scanner", is_alive=lambda: False)
    assert health.snapshot([worker])[2] == "scanner stopped"


def test_frozen_receiver_expires_despite_wall_clock_change(capture_health):
    health, clock = capture_health
    health.mark_samples()
    clock.time.return_value = 0
    clock.monotonic.return_value = 146
    assert health.snapshot([]) == (1000, 46, "No fresh FFT samples for 46.0s")


def test_watchdog_exits_process_and_removes_stale_heartbeat(tmp_path):
    path = Path(__file__).resolve().parents[2] / "decoders/unified-sdr/unified_sdr.py"
    tree = ast.parse(path.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "RFPowerMonitor")
    heartbeat = tmp_path / "heartbeat.json"
    heartbeat.write_text('{"timestamp": 1000}')
    script = (
        "import os, threading\nfrom types import SimpleNamespace\n"
        "time = SimpleNamespace(sleep=lambda _: None)\n"
        f"HEARTBEAT_PATH = {str(heartbeat)!r}\n"
        + ast.unparse(cls)
        + "\ntb = SimpleNamespace(capture_health=SimpleNamespace("
        "snapshot=lambda _: (1000, 46, 'No fresh FFT samples for 46.0s')))\n"
        "RFPowerMonitor(tb, []).run()\n"
    )
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=5)
    assert result.returncode == 1
    assert "exiting for receiver restart" in result.stdout
    assert not heartbeat.exists()
