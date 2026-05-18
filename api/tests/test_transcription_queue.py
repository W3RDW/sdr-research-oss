from pathlib import Path


def test_voice_retranscription_creates_retry_marker(tmp_path):
    from app.services.transcription import queue_retranscription

    audio_dir = tmp_path / "audio" / "voice"
    audio_dir.mkdir(parents=True)
    wav = audio_dir / "146940000_1700000000.wav"
    wav.write_bytes(b"fake wav")

    marker = queue_retranscription(str(wav), str(tmp_path / "text"), "voice")

    assert marker is not None
    assert Path(marker).name == "146940000_1700000000.wav.retry"
    assert Path(marker).exists()


def test_pager_audio_uses_voice_retry_marker(tmp_path):
    from app.services.transcription import queue_retranscription

    audio_dir = tmp_path / "audio" / "pager"
    audio_dir.mkdir(parents=True)
    wav = audio_dir / "152480000_1700000000.wav"
    wav.write_bytes(b"fake wav")

    marker = queue_retranscription(str(wav), str(tmp_path / "text"), None)

    assert marker is not None
    assert Path(marker).exists()


def test_cw_retranscription_only_touches_audio(tmp_path):
    from app.services.transcription import queue_retranscription

    audio_dir = tmp_path / "audio" / "cw"
    audio_dir.mkdir(parents=True)
    wav = audio_dir / "cw_144050000_1700000000.wav"
    wav.write_bytes(b"fake wav")

    marker = queue_retranscription(str(wav), str(tmp_path / "text"), "cw")

    assert marker is None
    assert not (tmp_path / "text").exists()
