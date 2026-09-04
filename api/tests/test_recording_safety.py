import asyncio
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
        asyncio.run(
            stream_file(
                1,
                request=None,
                db=_Database(SimpleNamespace(audio_path=None)),
            )
        )

    assert error.value.status_code == 404
    assert error.value.detail == "This recording has no audio file"


def test_partitioning_is_opt_in(monkeypatch):
    from app.services.indexer import _recordings_partitioning_enabled

    monkeypatch.delenv("ENABLE_RECORDINGS_PARTITIONING", raising=False)
    assert not _recordings_partitioning_enabled()
    monkeypatch.setenv("ENABLE_RECORDINGS_PARTITIONING", "true")
    assert _recordings_partitioning_enabled()
