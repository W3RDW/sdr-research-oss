from types import SimpleNamespace

import pytest
from fastapi import HTTPException


class _Query:
    def __init__(self, recording):
        self.recording = recording

    def filter(self, *_args):
        return self

    def first(self):
        return self.recording


class _Database:
    def __init__(self, recording):
        self.recording = recording

    def query(self, *_args):
        return _Query(self.recording)


def test_streaming_text_only_recording_returns_not_found():
    """Text-only modes must not cause os.path.exists(None) to return a 500."""
    from app.routers.files import stream_file

    with pytest.raises(HTTPException) as error:
        stream_file(
            1,
            request=None,
            db=_Database(SimpleNamespace(audio_path=None)),
        )

    assert error.value.status_code == 404
    assert error.value.detail == "This recording has no audio file"


def test_partitioning_is_opt_in(monkeypatch):
    from app.services.indexer import _recordings_partitioning_enabled

    monkeypatch.delenv("ENABLE_RECORDINGS_PARTITIONING", raising=False)
    assert not _recordings_partitioning_enabled()
    monkeypatch.setenv("ENABLE_RECORDINGS_PARTITIONING", "true")
    assert _recordings_partitioning_enabled()


@pytest.mark.parametrize("mode,duration,freq,expected", [
    ("voice", 1.5, 155000000, True),
    ("voice", 2.0, 146520000, True),
    ("voice", 2.66, 224000000, True),
    ("voice", 2.999, 155000000, True),
    ("voice", 3.0, 155000000, False),
    ("voice", None, 155000000, False),
    ("voice", 1.0, 144390000, False),
    ("voice", 1.0, 145825000, False),
    ("voice", 1.0, None, True),
    ("cw", 1.0, 14060000, False),
])
def test_short_voice_cleanup(mode, duration, freq, expected):
    from app.services.indexer import should_auto_delete_short_voice

    assert should_auto_delete_short_voice(mode, duration, freq) is expected


class _Resp:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body.encode()


@pytest.mark.parametrize("url,expected_path,body", [
    ("http://vllm:8000/v1", "/v1/chat/completions",
     '{"choices":[{"message":{"content":"{\\"tags\\":[\\"Fire\\",\\"emergency\\"]}"}}]}'),
    ("http://ollama:11434", "/api/generate",
     '{"response":"{\\"tags\\":[\\"Fire\\",\\"emergency\\"]}"}'),
])
def test_tagger_backends(monkeypatch, url, expected_path, body):
    import json

    from app.services import indexer

    sent = {}

    def fake_urlopen(req, timeout):
        sent["url"] = req.full_url
        sent["payload"] = json.loads(req.data)
        return _Resp(body)

    monkeypatch.setattr(indexer.settings, "ollama_enabled", True)
    monkeypatch.setattr(indexer.settings, "ollama_url", url)
    monkeypatch.setattr(indexer.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(indexer, "_ollama_circuit_open_until", 0.0)

    tags, failed = indexer.generate_ollama_tags("engine 4 responding to a structure fire on main street")

    assert not failed
    assert sent["url"].endswith(expected_path)
    assert ("messages" in sent["payload"]) == expected_path.endswith("completions")
    assert {"fire", "emergency"} <= set(tags)


def _write_wav(path, segments, rate=16000):
    import wave

    import numpy as np

    audio = np.concatenate([
        (np.sin(2 * np.pi * 1000 * np.arange(int(rate * sec)) / rate) * 0.3 * active)
        for sec, active in segments
    ])
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((audio * 32767).astype("<i2").tobytes())


@pytest.mark.parametrize("segments,expected", [
    # Sparse 40 ms blips over 4.4 s (the screenshot artifact)
    ([(0.5, 0), (0.04, 1), (0.8, 0), (0.04, 1), (1.5, 0), (0.06, 1), (1.4, 0), (0.04, 1)], True),
    # Speech-like: 250 ms syllables with short gaps
    ([(0.25, 1), (0.1, 0)] * 12, False),
    # One real 300 ms word in otherwise silent audio is not a click burst
    ([(2.0, 0), (0.3, 1), (2.0, 0)], False),
    # Dense rapid blips exceed the active-fraction limit
    ([(0.06, 1), (0.1, 0)] * 30, False),
])
def test_click_burst_detection(tmp_path, segments, expected):
    from app.services.audio import is_click_burst_audio

    path = tmp_path / "rec.wav"
    _write_wav(path, segments)
    assert is_click_burst_audio(str(path)) is expected


def test_click_burst_cleanup_scope(tmp_path):
    from app.services.indexer import should_auto_delete_click_burst

    path = tmp_path / "rec.wav"
    _write_wav(path, [(1.0, 0), (0.04, 1), (2.0, 0), (0.04, 1), (1.0, 0)])
    assert should_auto_delete_click_burst("voice", 4.1, 145482910, str(path))
    assert not should_auto_delete_click_burst("voice", 4.1, 144390000, str(path))
    assert not should_auto_delete_click_burst("cw", 4.1, 14060000, str(path))
    assert not should_auto_delete_click_burst("voice", 20.0, 145482910, str(path))
    assert not should_auto_delete_click_burst("voice", 4.1, 145482910, str(tmp_path / "missing.wav"))
