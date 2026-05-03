import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Recording
from ..config import settings
from ..services.audio import generate_waveform_peaks, generate_spectrogram

router = APIRouter()


def _ensure_cache_dir(subdir: str) -> Path:
    """Return a writable cache subdirectory, falling back to /tmp when needed."""
    preferred = Path(settings.cache_path) / subdir
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        return preferred
    except PermissionError:
        fallback = Path("/tmp/sdr-viewer-cache") / subdir
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


@router.get("/{file_id}")
async def get_waveform(file_id: int, response: Response, db: Session = Depends(get_db)):
    """Get waveform peaks data for visualization."""
    response.headers["Cache-Control"] = "public, max-age=86400, immutable"
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")

    rec_id = recording.id
    audio_path = recording.audio_path

    # Check cache
    cache_dir = _ensure_cache_dir("waveforms")
    cache_file = cache_dir / f"{rec_id}.json"

    if cache_file.exists():
        import json

        with open(cache_file, "r") as f:
            return JSONResponse(
                json.load(f),
                headers={"Cache-Control": "public, max-age=86400, immutable"},
            )

    # Release DB session before heavy generation
    db.close()

    if not os.path.exists(audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    try:
        peaks_data = generate_waveform_peaks(audio_path)

        import json
        with open(cache_file, "w") as f:
            json.dump(peaks_data, f)

        # Update cache path in a fresh session
        from ..database import SessionLocal
        _db = SessionLocal()
        try:
            _db.execute(
                __import__("sqlalchemy").text(
                    "UPDATE recordings SET waveform_cached = :p WHERE id = :id"
                ),
                {"p": str(cache_file), "id": rec_id},
            )
            _db.commit()
        finally:
            _db.close()

        return JSONResponse(peaks_data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate waveform: {e}")


@router.get("/{file_id}/spectrogram")
async def get_spectrogram(file_id: int, response: Response, db: Session = Depends(get_db)):
    """Get spectrogram image."""
    response.headers["Cache-Control"] = "public, max-age=86400, immutable"
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")

    rec_id = recording.id
    audio_path = recording.audio_path

    # Check cache
    cache_dir = _ensure_cache_dir("spectrograms")
    cache_file = cache_dir / f"{rec_id}.png"

    if cache_file.exists():
        return FileResponse(
            cache_file,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )

    # Release DB session before heavy generation
    db.close()

    if not os.path.exists(audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    try:
        generate_spectrogram(audio_path, str(cache_file))

        # Update cache path in a fresh session
        from ..database import SessionLocal
        _db = SessionLocal()
        try:
            _db.execute(
                __import__("sqlalchemy").text(
                    "UPDATE recordings SET spectrogram_cached = :p WHERE id = :id"
                ),
                {"p": str(cache_file), "id": rec_id},
            )
            _db.commit()
        finally:
            _db.close()

        return FileResponse(
            cache_file,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate spectrogram: {e}")
