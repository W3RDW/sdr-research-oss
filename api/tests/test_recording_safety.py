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
    ("voice", 2.001, 155000000, False),
    ("voice", None, 155000000, False),
    ("voice", 1.0, 144390000, False),
    ("voice", 1.0, 145825000, False),
    ("voice", 1.0, None, True),
    ("cw", 1.0, 14060000, False),
])
def test_short_voice_cleanup(mode, duration, freq, expected):
    from app.services.indexer import should_auto_delete_short_voice

    assert should_auto_delete_short_voice(mode, duration, freq) is expected
