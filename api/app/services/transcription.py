"""Helpers for re-queueing audio for decoder-side transcription."""

import os
from typing import Optional


VOICE_RETRY_SUFFIX = ".retry"


def voice_retry_marker_path(audio_path: str, text_base_path: str) -> str:
    return os.path.join(
        text_base_path,
        "voice",
        os.path.basename(audio_path) + VOICE_RETRY_SUFFIX,
    )


def audio_uses_voice_decoder(audio_path: str, mode: Optional[str] = None) -> bool:
    if (mode or "").lower() == "voice":
        return True
    parts = set(os.path.normpath(audio_path).split(os.sep))
    return "voice" in parts or "pager" in parts


def queue_retranscription(audio_path: str, text_base_path: str, mode: Optional[str] = None) -> Optional[str]:
    """Mark an audio file for retry by the decoder that owns it.

    Voice transcription uses a bounded filename window for performance, so
    touching old audio is not enough. The voice decoder also watches for this
    marker and retries the matching WAV regardless of embedded timestamp.
    """
    if not audio_path:
        return None

    try:
        os.utime(audio_path, None)
    except OSError:
        pass

    if not audio_uses_voice_decoder(audio_path, mode):
        return None

    marker_path = voice_retry_marker_path(audio_path, text_base_path)
    os.makedirs(os.path.dirname(marker_path), exist_ok=True)
    tmp_path = marker_path + ".tmp"
    with open(tmp_path, "w") as marker:
        marker.write("retry\n")
    os.replace(tmp_path, marker_path)
    return marker_path
