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
