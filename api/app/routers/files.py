import io
import os
import zipfile
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
from sqlalchemy import desc, func, or_, text as sql_text
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import CallsignInfo, Recording, Repeater
from ..services.known_freqs import classify_frequency_group, frequency_group_label
from ..services.tagging import extract_callsign_tags, is_no_speech_transcript, normalize_callsign, parse_ai_tags

router = APIRouter()


class UpdateRecordingRequest(BaseModel):
    ai_tags: Optional[List[str]] = None
    transcript: Optional[str] = None


class ModeChangeRequest(BaseModel):
    mode: str  # "voice" or "cw"

class BulkDeleteRequest(BaseModel):
    ids: List[int]


class BulkDeleteFilteredRequest(BaseModel):
    mode: Optional[str] = None
    frequency_min: Optional[float] = None
    frequency_max: Optional[float] = None
    q: Optional[str] = None
    callsign: Optional[str] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    duration_min: Optional[float] = None
    duration_max: Optional[float] = None
    has_transcript: Optional[bool] = None
    transcript_pending: Optional[bool] = None
    dry_run: bool = False


_VALID_MODES = {"cw", "voice", "aprs", "pager", "eas", "acars", "vdl2", "hfdl", "sstv"}

def _validate_mode(mode: Optional[str]):
    if mode is not None and mode not in _VALID_MODES:
        raise HTTPException(status_code=422, detail=f"mode must be one of: {', '.join(sorted(_VALID_MODES))}")


def _validate_duration_bounds(duration_min: Optional[float], duration_max: Optional[float]):
    if (
        duration_min is not None
        and duration_max is not None
        and duration_min > duration_max
    ):
        raise HTTPException(
            status_code=422,
            detail="duration_min cannot be greater than duration_max",
        )


def _all_tags(callsign_tags: List[str], ai_tags: List[str]) -> List[str]:
    return list(dict.fromkeys(callsign_tags + ai_tags))


def _frequency_group_fields(
    frequency_hz: Optional[float],
    frequency_label: Optional[str],
    mode: Optional[str] = None,
    repeater_id: Optional[int] = None,
) -> dict:
    group = classify_frequency_group(
        frequency_hz=frequency_hz,
        label=frequency_label,
        mode=mode,
        repeater_id=repeater_id,
    )
    return {
        "frequency_group": group,
        "frequency_group_label": frequency_group_label(group),
    }


_FAILED_MARKERS = frozenset({
    "ACARS_DECODE_FAILED", "PAGER_DECODE_FAILED", "EAS_NO_ALERT", "VDL2_DECODE_FAILED",
    "[no transcribable audio]",
})

def _transcript_status(r) -> str:
    text = (r.transcript or "").strip()
    if (text and not is_no_speech_transcript(text)
            and text != "[no decodable cw]"
            and text not in _FAILED_MARKERS):
        return "yes"
    if r.transcript is None and r.mode in ("voice", "cw"):
        return "pending"
    return "no"


def _apply_recording_filters(
    query,
    mode: Optional[str] = None,
    frequency_min: Optional[float] = None,
    frequency_max: Optional[float] = None,
    q: Optional[str] = None,
    callsign: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    duration_min: Optional[float] = None,
    duration_max: Optional[float] = None,
    has_transcript: Optional[bool] = None,
    transcript_pending: Optional[bool] = None,
):
    if mode:
        query = query.filter(Recording.mode == mode)
    if frequency_min is not None:
        query = query.filter(Recording.frequency_hz >= frequency_min)
    if frequency_max is not None:
        query = query.filter(Recording.frequency_hz <= frequency_max)

    if q:
        cleaned_q = q.strip()
        if cleaned_q:
            search_query = func.plainto_tsquery("english", cleaned_q)
            query = query.filter(
                or_(
                    Recording.search_vector.op("@@")(search_query),
                    Recording.transcript.ilike(f"%{cleaned_q}%"),
                )
            )

    if callsign:
        normalized_callsign = normalize_callsign(callsign)
        if normalized_callsign:
            normalized_transcript = func.regexp_replace(
                func.upper(func.coalesce(Recording.transcript, "")),
                "[^A-Z0-9]+",
                "",
                "g",
            )
            query = query.filter(normalized_transcript.ilike(f"%{normalized_callsign}%"))

    if date_from:
        query = query.filter(Recording.timestamp >= date_from)
    if date_to:
        query = query.filter(Recording.timestamp <= date_to)
    if duration_min is not None:
        query = query.filter(Recording.duration_seconds >= duration_min)
    if duration_max is not None:
        query = query.filter(Recording.duration_seconds <= duration_max)

    transcript_len = func.length(func.trim(func.coalesce(Recording.transcript, "")))
    if has_transcript is True:
        query = query.filter(transcript_len > 0)
    elif has_transcript is False:
        query = query.filter(transcript_len == 0)

    if transcript_pending is True:
        query = query.filter(
            Recording.mode.in_(["voice", "cw"]),
            Recording.transcript.is_(None),
        )

    return query


def _apply_tag_filter(query, tag: Optional[str]):
    """Filter by an AI or callsign tag substring present in the JSON tags list."""
    if not tag:
        return query
    cleaned = tag.strip().lower()
    if not cleaned:
        return query
    # ai_tags is JSONB — cast to text for ILIKE compatibility
    from sqlalchemy import String as _StrType
    query = query.filter(Recording.ai_tags.cast(_StrType).ilike(f'%"{cleaned}"%'))
    return query


@router.get("/browse")
async def browse_files(
    mode: Optional[str] = Query(None, pattern="^(cw|voice|aprs|pager|eas|acars|vdl2|hfdl|sstv)$"),
    frequency_min: Optional[float] = None,
    frequency_max: Optional[float] = None,
    q: Optional[str] = Query(None, min_length=1),
    callsign: Optional[str] = Query(None, min_length=1, max_length=20),
    tag: Optional[str] = Query(None, min_length=1, max_length=50),
    repeater: Optional[str] = Query(None, min_length=1, max_length=20),
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    duration_min: Optional[float] = Query(None, ge=0),
    duration_max: Optional[float] = Query(None, ge=0),
    has_transcript: Optional[bool] = None,
    transcript_pending: Optional[bool] = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """List recordings with optional filters. APRS is excluded — use the APRS tab."""
    _validate_duration_bounds(duration_min, duration_max)

    query = _apply_recording_filters(
        db.query(Recording),
        mode=mode,
        frequency_min=frequency_min,
        frequency_max=frequency_max,
        q=q,
        callsign=callsign,
        date_from=date_from,
        date_to=date_to,
        duration_min=duration_min,
        duration_max=duration_max,
        has_transcript=has_transcript,
        transcript_pending=transcript_pending,
    )
    if not mode and not callsign:
        query = query.filter(Recording.mode != "aprs")
    query = _apply_tag_filter(query, tag)

    if repeater:
        query = (
            query
            .join(Repeater, Recording.repeater_id == Repeater.id)
            .filter(Repeater.callsign.ilike(f"%{repeater.strip().upper()}%"))
        )

    total = query.count()
    recordings = (
        query.order_by(desc(Recording.timestamp))
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return {
        "total": total,
        "page": page,
        "limit": limit,
        "items": [
            {
                "id": r.id,
                "filename": r.filename,
                "mode": r.mode,
                "frequency_hz": r.frequency_hz,
                "frequency_label": r.frequency_label,
                **_frequency_group_fields(r.frequency_hz, r.frequency_label, r.mode, r.repeater_id),
                "timestamp": r.timestamp.isoformat() if r.timestamp else None,
                "duration_seconds": r.duration_seconds,
                "has_transcript": bool((r.transcript or "").strip()),
                "transcript_status": _transcript_status(r),
                "signal_db": r.signal_db,
                "source_sdr": getattr(r, "source_sdr", None),
                "callsign_tags": (callsign_tags := extract_callsign_tags(r.transcript)),
                "ai_tags": (ai_tags := parse_ai_tags(r.ai_tags)),
                "tags": _all_tags(callsign_tags, ai_tags),
            }
            for r in recordings
        ],
    }


@router.get("/callsign/{callsign}")
async def get_callsign_info(callsign: str, db: Session = Depends(get_db)):
    """Return operator info and recording statistics for a callsign."""
    cs = callsign.strip().upper()
    # Strip SSID (e.g. W1AW-8 → W1AW) for operator DB lookup
    base_cs = re.sub(r"-\w+$", "", cs)
    info = (
        db.query(CallsignInfo).filter(CallsignInfo.callsign == cs).first()
        or db.query(CallsignInfo).filter(CallsignInfo.callsign == base_cs).first()
    )
    normalized_cs = normalize_callsign(cs)
    total = 0
    first_heard = None
    last_heard = None
    total_airtime = 0.0
    if normalized_cs:
        normalized_transcript = func.regexp_replace(
            func.upper(func.coalesce(Recording.transcript, "")),
            "[^A-Z0-9]+",
            "",
            "g",
        )
        base_q = db.query(Recording).filter(
            normalized_transcript.ilike(f"%{normalized_cs}%")
        )
        total = base_q.count()
        first_heard = (
            db.query(func.min(Recording.timestamp))
            .filter(normalized_transcript.ilike(f"%{normalized_cs}%"))
            .scalar()
        )
        last_heard = (
            db.query(func.max(Recording.timestamp))
            .filter(normalized_transcript.ilike(f"%{normalized_cs}%"))
            .scalar()
        )
        total_airtime = (
            db.query(func.sum(Recording.duration_seconds))
            .filter(normalized_transcript.ilike(f"%{normalized_cs}%"))
            .scalar()
        ) or 0.0
    return {
        "callsign": cs,
        "operator": {
            "name": info.name,
            "qth_city": info.qth_city,
            "qth_state": info.qth_state,
            "license_class": info.license_class,
            "grid": info.grid,
        } if info else None,
        "total_recordings": total,
        "first_heard": first_heard.isoformat() if first_heard else None,
        "last_heard": last_heard.isoformat() if last_heard else None,
        "total_airtime_seconds": round(total_airtime, 1),
    }


@router.get("/{file_id}")
async def get_file(file_id: int, db: Session = Depends(get_db)):
    """Get file metadata and transcript."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")

    callsign_tags = extract_callsign_tags(recording.transcript)
    ai_tags = parse_ai_tags(recording.ai_tags)

    # Repeater info
    repeater_info = None
    if recording.repeater_id:
        rep = db.query(Repeater).filter(Repeater.id == recording.repeater_id).first()
        if rep:
            repeater_info = {
                "id": rep.id,
                "callsign": rep.callsign,
                "location": rep.location,
                "county": rep.county,
                "state": rep.state,
                "frequency_hz": rep.frequency_hz,
                "input_hz": rep.input_hz,
                "pl_tone": rep.pl_tone,
                "digital_modes": [m.strip() for m in rep.digital_modes.split(",")] if rep.digital_modes else [],
                "linked_nodes": rep.linked_nodes,
                "use": rep.use,
            }

    # Operator info for callsigns heard in transcript
    operators = []
    for cs in callsign_tags[:5]:
        info = db.query(CallsignInfo).filter(CallsignInfo.callsign == cs).first()
        if info:
            operators.append({
                "callsign": info.callsign,
                "name": info.name,
                "qth_city": info.qth_city,
                "qth_state": info.qth_state,
                "license_class": info.license_class,
                "grid": info.grid,
            })

    return {
        "id": recording.id,
        "filename": recording.filename,
        "mode": recording.mode,
        "frequency_hz": recording.frequency_hz,
        "timestamp": recording.timestamp.isoformat() if recording.timestamp else None,
        "duration_seconds": recording.duration_seconds,
        "transcript": recording.transcript,
        "transcript_status": _transcript_status(recording),
        "frequency_label": recording.frequency_label,
        **_frequency_group_fields(recording.frequency_hz, recording.frequency_label, recording.mode, recording.repeater_id),
        "callsign_tags": callsign_tags,
        "ai_tags": ai_tags,
        "tags": _all_tags(callsign_tags, ai_tags),
        "signal_db": recording.signal_db,
        "source_sdr": getattr(recording, "source_sdr", None),
        "has_waveform": recording.waveform_cached is not None,
        "has_spectrogram": recording.spectrogram_cached is not None,
        "repeater": repeater_info,
        "operators": operators,
    }


@router.get("/{file_id}/neighbors")
async def get_file_neighbors(file_id: int, db: Session = Depends(get_db)):
    """Get previous and next recording IDs by timestamp."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    ts = recording.timestamp
    if ts:
        prev_rec = (
            db.query(Recording.id)
            .filter(Recording.timestamp < ts)
            .order_by(desc(Recording.timestamp))
            .first()
        )
        next_rec = (
            db.query(Recording.id)
            .filter(Recording.timestamp > ts)
            .order_by(Recording.timestamp)
            .first()
        )
    else:
        prev_rec = (
            db.query(Recording.id)
            .filter(Recording.id < file_id)
            .order_by(desc(Recording.id))
            .first()
        )
        next_rec = (
            db.query(Recording.id)
            .filter(Recording.id > file_id)
            .order_by(Recording.id)
            .first()
        )
    return {
        "prev_id": prev_rec[0] if prev_rec else None,
        "next_id": next_rec[0] if next_rec else None,
    }


@router.get("/{file_id}/related")
async def get_related_recordings(file_id: int, db: Session = Depends(get_db)):
    """Get nearby recordings on the same frequency (±10 kHz, ±1 hour)."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    items = []
    if recording.frequency_hz is not None and recording.timestamp is not None:
        ts_min = recording.timestamp - timedelta(hours=1)
        ts_max = recording.timestamp + timedelta(hours=1)
        freq_min = recording.frequency_hz - 10000
        freq_max = recording.frequency_hz + 10000
        rows = (
            db.query(Recording)
            .filter(
                Recording.id != recording.id,
                Recording.frequency_hz.between(freq_min, freq_max),
                Recording.timestamp.between(ts_min, ts_max),
            )
            .order_by(desc(Recording.timestamp))
            .limit(10)
            .all()
        )
        for r in rows:
            cs_tags = extract_callsign_tags(r.transcript)
            ai_tags_list = parse_ai_tags(r.ai_tags)
            items.append({
                "id": r.id,
                "filename": r.filename,
                "mode": r.mode,
                "frequency_hz": r.frequency_hz,
                "frequency_label": r.frequency_label,
                **_frequency_group_fields(r.frequency_hz, r.frequency_label, r.mode, r.repeater_id),
                "timestamp": r.timestamp.isoformat() if r.timestamp else None,
                "duration_seconds": r.duration_seconds,
                "has_transcript": bool((r.transcript or "").strip()),
                "transcript_status": _transcript_status(r),
                "callsign_tags": cs_tags,
                "ai_tags": ai_tags_list,
                "tags": _all_tags(cs_tags, ai_tags_list),
            })
    return {"items": items, "count": len(items)}


@router.patch("/{file_id}")
async def update_recording(
    file_id: int, body: UpdateRecordingRequest, db: Session = Depends(get_db)
):
    """Update mutable fields on a recording (ai_tags and/or transcript)."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")

    if body.ai_tags is not None:
        from ..services.tagging import dump_ai_tags
        recording.ai_tags = dump_ai_tags(body.ai_tags)

    if body.transcript is not None:
        from ..services.indexer import update_search_vector
        new_transcript = body.transcript.strip() or None
        recording.transcript = new_transcript
        db.execute(
            sql_text("UPDATE recordings SET search_vector = NULL WHERE id = :id"),
            {"id": recording.id},
        )
        db.commit()
        if new_transcript:
            update_search_vector(db, recording.id, new_transcript)
    else:
        db.commit()
    ai_tags = parse_ai_tags(recording.ai_tags)
    callsign_tags = extract_callsign_tags(recording.transcript)
    return {
        "id": recording.id,
        "ai_tags": ai_tags,
        "callsign_tags": callsign_tags,
        "tags": _all_tags(callsign_tags, ai_tags),
        "transcript": recording.transcript,
    }


@router.patch("/{file_id}/mode")
async def reclassify_recording_mode(
    file_id: int, body: ModeChangeRequest, db: Session = Depends(get_db)
):
    """Reclassify a voice recording as CW or vice versa.

    Moves the audio file to the appropriate directory, deletes any existing
    transcript, and resets mode so the correct decoder re-processes it.
    """
    from ..config import settings as _settings

    def _unlink(p):
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except OSError:
            pass

    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")

    new_mode = body.mode
    if new_mode not in ("voice", "cw"):
        raise HTTPException(status_code=400, detail="Mode must be 'voice' or 'cw'")
    if recording.mode not in ("voice", "cw"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot reclassify recordings with mode='{recording.mode}'"
        )
    if recording.mode == new_mode:
        raise HTTPException(status_code=400, detail=f"Recording is already mode='{new_mode}'")

    # Move audio file to the directory the target decoder watches
    new_audio_path = recording.audio_path
    if recording.audio_path and os.path.exists(recording.audio_path):
        old_base = os.path.basename(recording.audio_path)
        if new_mode == "cw":
            new_name = old_base if old_base.startswith("cw_") else f"cw_{old_base}"
            new_audio_path = os.path.join(_settings.audio_base_path, "cw", new_name)
        else:
            new_name = old_base[3:] if old_base.startswith("cw_") else old_base
            new_audio_path = os.path.join(_settings.audio_base_path, "voice", new_name)
        os.makedirs(os.path.dirname(new_audio_path), exist_ok=True)
        os.rename(recording.audio_path, new_audio_path)
        # Touch so the incremental mtime scanner picks it up on next cycle.
        # os.rename preserves the original mtime, which may predate the
        # scanner's last-run timestamp, causing the file to be skipped.
        try:
            import pathlib as _pathlib
            _pathlib.Path(new_audio_path).touch()
        except OSError:
            pass

    # Delete any existing text files for this recording
    if recording.audio_path:
        base = os.path.basename(recording.audio_path).replace(".wav", ".txt")
        base_stripped = base[3:] if base.startswith("cw_") else base
        for sub in ("voice", "cw"):
            for b in {base, base_stripped, f"cw_{base_stripped}"}:
                _unlink(os.path.join(_settings.text_base_path, sub, b))
    _unlink(recording.text_path)

    # Reset for re-processing
    recording.filename = os.path.basename(new_audio_path)  # must match new file name
    recording.mode = new_mode
    recording.transcript = None
    recording.text_path = None
    recording.audio_path = new_audio_path
    db.execute(
        sql_text("UPDATE recordings SET search_vector = NULL WHERE id = :id"),
        {"id": recording.id},
    )
    db.commit()
    return {"id": recording.id, "mode": new_mode, "status": "re-queued"}


@router.post("/{file_id}/retag")
async def retag_recording(file_id: int, db: Session = Depends(get_db)):
    """Clear AI tags so the indexer re-runs tagging on the next cycle."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    recording.ai_tags = None
    db.commit()
    return {"status": "ok", "message": "AI tags cleared — will be regenerated on next indexer cycle"}


@router.post("/{file_id}/retranscribe")
async def retranscribe_recording(file_id: int, db: Session = Depends(get_db)):
    """Clear transcript and delete text file so Whisper re-transcribes on next cycle."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    if not recording.audio_path:
        raise HTTPException(status_code=400, detail="No audio file — cannot re-transcribe")
    if recording.text_path and os.path.exists(recording.text_path):
        try:
            os.remove(recording.text_path)
        except OSError:
            pass
    recording.transcript = None
    recording.text_path = None
    recording.ai_tags = None
    db.execute(sql_text("UPDATE recordings SET search_vector = NULL WHERE id = :id"), {"id": recording.id})
    db.commit()
    return {"status": "ok", "message": "Transcript cleared — Whisper will re-transcribe on next cycle"}


@router.get("/{file_id}/stream")
async def stream_file(file_id: int, request: Request, db: Session = Depends(get_db)):
    """Stream audio file with Range request support."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")

    audio_path = recording.audio_path
    if not os.path.exists(audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    file_size = os.path.getsize(audio_path)

    # Handle Range requests for seeking
    range_header = request.headers.get("Range")
    if range_header:
        try:
            range_spec = range_header.replace("bytes=", "")
            start, end = range_spec.split("-")
            start = int(start) if start else 0
            end = int(end) if end else file_size - 1
            end = min(end, file_size - 1)

            content_length = end - start + 1

            def iter_file():
                with open(audio_path, "rb") as f:
                    f.seek(start)
                    remaining = content_length
                    while remaining > 0:
                        chunk_size = min(8192, remaining)
                        data = f.read(chunk_size)
                        if not data:
                            break
                        remaining -= len(data)
                        yield data

            return StreamingResponse(
                iter_file(),
                status_code=206,
                media_type="audio/wav",
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Content-Length": str(content_length),
                    "Accept-Ranges": "bytes",
                },
            )
        except (ValueError, IndexError):
            pass

    # Full file response
    return FileResponse(
        audio_path,
        media_type="audio/wav",
        headers={"Accept-Ranges": "bytes"},
    )


@router.get("/{file_id}/image")
async def serve_image(file_id: int, db: Session = Depends(get_db)):
    """Serve an image file (for mode=sstv SSTV captures; audio_path holds image path)."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    if recording.mode != "sstv" or not recording.audio_path:
        raise HTTPException(status_code=400, detail="Not an image recording")
    path = recording.audio_path
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image file not found")
    ext = os.path.splitext(path)[1].lower()
    media_type = "image/png" if ext == ".png" else "image/jpeg"
    return FileResponse(path, media_type=media_type)


def _delete_recording_files(recording: Recording):
    """Remove audio, text, and cache files for a recording."""
    for path in [
        recording.audio_path,
        recording.text_path,
        recording.waveform_cached,
        recording.spectrogram_cached,
    ]:
        if path:
            try:
                os.remove(path)
            except OSError:
                pass


@router.delete("/{file_id}")
async def delete_file(file_id: int, db: Session = Depends(get_db)):
    """Delete a single recording and its files."""
    recording = db.query(Recording).filter(Recording.id == file_id).first()
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")

    _delete_recording_files(recording)
    db.delete(recording)
    db.commit()
    return {"deleted": 1}


@router.post("/bulk-delete")
async def bulk_delete_files(body: BulkDeleteRequest, db: Session = Depends(get_db)):
    """Delete multiple recordings by ID."""
    recordings = db.query(Recording).filter(Recording.id.in_(body.ids)).all()
    count = 0
    for recording in recordings:
        _delete_recording_files(recording)
        db.delete(recording)
        count += 1
    db.commit()
    return {"deleted": count}


@router.post("/bulk-delete-filtered")
async def bulk_delete_filtered_files(
    body: BulkDeleteFilteredRequest,
    db: Session = Depends(get_db),
):
    """Delete all recordings matching the provided filter criteria."""
    _validate_mode(body.mode)
    _validate_duration_bounds(body.duration_min, body.duration_max)

    has_any_filter = any(
        [
            body.mode is not None,
            body.frequency_min is not None,
            body.frequency_max is not None,
            body.q is not None,
            body.callsign is not None,
            body.date_from is not None,
            body.date_to is not None,
            body.duration_min is not None,
            body.duration_max is not None,
            body.has_transcript is not None,
            body.transcript_pending is not None,
        ]
    )
    if not has_any_filter:
        raise HTTPException(
            status_code=400,
            detail="At least one filter is required for bulk-delete-filtered",
        )

    query = _apply_recording_filters(
        db.query(Recording),
        mode=body.mode,
        frequency_min=body.frequency_min,
        frequency_max=body.frequency_max,
        q=body.q,
        callsign=body.callsign,
        date_from=body.date_from,
        date_to=body.date_to,
        duration_min=body.duration_min,
        duration_max=body.duration_max,
        has_transcript=body.has_transcript,
        transcript_pending=body.transcript_pending,
    )
    recordings = query.all()
    matched = len(recordings)

    if body.dry_run:
        return {"matched": matched, "deleted": 0}

    for recording in recordings:
        _delete_recording_files(recording)
        db.delete(recording)
    db.commit()

    return {"matched": matched, "deleted": matched}


@router.get("/tags/list")
async def list_tags(limit: int = 200, db: Session = Depends(get_db)):
    """Return all distinct AI tags sorted by usage count for autocomplete."""
    rows = (
        db.query(Recording.ai_tags)
        .filter(Recording.ai_tags.isnot(None))
        .yield_per(2000)
    )
    counts: dict = {}
    for (raw,) in rows:
        for tag in parse_ai_tags(raw):
            counts[tag] = counts.get(tag, 0) + 1
    sorted_tags = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:limit]
    return {"tags": [{"tag": t, "count": c} for t, c in sorted_tags]}


class UpdateNotesRequest(BaseModel):
    notes: Optional[str] = None


@router.patch("/{recording_id}/notes")
async def update_notes(
    recording_id: int,
    body: UpdateNotesRequest,
    db: Session = Depends(get_db),
):
    """Update operator notes on a recording."""
    rec = db.query(Recording).filter(Recording.id == recording_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Recording not found")
    rec.notes = body.notes
    db.commit()
    return {"id": recording_id, "notes": rec.notes}


@router.get("/export-zip")
async def export_zip(
    mode: Optional[str] = None,
    frequency_min: Optional[float] = None,
    frequency_max: Optional[float] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    tag: Optional[str] = None,
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """Stream a ZIP archive of matching audio recordings (WAV files only)."""
    query = db.query(Recording).filter(Recording.audio_path.isnot(None))
    if mode:
        query = query.filter(Recording.mode == mode)
    if frequency_min is not None:
        query = query.filter(Recording.frequency_hz >= frequency_min)
    if frequency_max is not None:
        query = query.filter(Recording.frequency_hz <= frequency_max)
    if date_from:
        query = query.filter(Recording.timestamp >= date_from)
    if date_to:
        query = query.filter(Recording.timestamp <= date_to)
    if tag:
        from sqlalchemy import String as _StrType
        query = query.filter(Recording.ai_tags.cast(_StrType).ilike(f'%"{tag}"%'))
    recordings = query.order_by(Recording.timestamp.desc()).limit(limit).all()

    def generate_zip():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            for rec in recordings:
                if rec.audio_path and os.path.exists(rec.audio_path):
                    arcname = os.path.basename(rec.audio_path)
                    zf.write(rec.audio_path, arcname=arcname)
        buf.seek(0)
        yield buf.read()

    count = len(recordings)
    return StreamingResponse(
        generate_zip(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="sdr-recordings-{count}.zip"',
            "X-Recording-Count": str(count),
        },
    )


# ── Frequency Bookmarks ──────────────────────────────────────────────────────

class BookmarkCreate(BaseModel):
    frequency_hz: float
    bandwidth_hz: float = 5000.0
    label: str
    notes: Optional[str] = None
    alert_on_activity: bool = False


class BookmarkUpdate(BaseModel):
    label: Optional[str] = None
    bandwidth_hz: Optional[float] = None
    notes: Optional[str] = None
    alert_on_activity: Optional[bool] = None


def _bm_row(bm) -> dict:
    return {
        "id": bm.id,
        "frequency_hz": bm.frequency_hz,
        "bandwidth_hz": bm.bandwidth_hz,
        "label": bm.label,
        "notes": bm.notes,
        "alert_on_activity": bm.alert_on_activity,
        "created_at": bm.created_at.isoformat() if bm.created_at else None,
    }


@router.get("/bookmarks")
async def list_bookmarks(db: Session = Depends(get_db)):
    from ..models import FrequencyBookmark
    rows = db.query(FrequencyBookmark).order_by(FrequencyBookmark.frequency_hz).all()
    return {"items": [_bm_row(r) for r in rows]}


@router.post("/bookmarks", status_code=201)
async def create_bookmark(body: BookmarkCreate, db: Session = Depends(get_db)):
    from ..models import FrequencyBookmark
    if not body.label.strip():
        raise HTTPException(status_code=422, detail="label cannot be empty")
    bm = FrequencyBookmark(
        frequency_hz=body.frequency_hz,
        bandwidth_hz=body.bandwidth_hz,
        label=body.label.strip(),
        notes=body.notes,
        alert_on_activity=body.alert_on_activity,
    )
    db.add(bm)
    db.commit()
    db.refresh(bm)
    return _bm_row(bm)


@router.patch("/bookmarks/{bookmark_id}")
async def update_bookmark(
    bookmark_id: int, body: BookmarkUpdate, db: Session = Depends(get_db)
):
    from ..models import FrequencyBookmark
    bm = db.query(FrequencyBookmark).filter(FrequencyBookmark.id == bookmark_id).first()
    if not bm:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    if body.label is not None:
        bm.label = body.label.strip()
    if body.bandwidth_hz is not None:
        bm.bandwidth_hz = body.bandwidth_hz
    if body.notes is not None:
        bm.notes = body.notes
    if body.alert_on_activity is not None:
        bm.alert_on_activity = body.alert_on_activity
    db.commit()
    return _bm_row(bm)


@router.delete("/bookmarks/{bookmark_id}")
async def delete_bookmark(bookmark_id: int, db: Session = Depends(get_db)):
    from ..models import FrequencyBookmark
    bm = db.query(FrequencyBookmark).filter(FrequencyBookmark.id == bookmark_id).first()
    if not bm:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    db.delete(bm)
    db.commit()
    return {"deleted": bookmark_id}
