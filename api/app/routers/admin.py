import asyncio
import glob as _glob
import json
import os
import re
import shutil
import time as _time
from datetime import datetime, timedelta, timezone

import urllib.request

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, text as _sql_text
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import AlertHistory, FrequencyLabel, Recording, Repeater
from ..services.alerting import _send_webhook
from ..services.indexer import maybe_set_ai_tags, maybe_set_frequency_metadata
from ..services.repeater import sync_repeaters

router = APIRouter()


async def _require_auth(x_authentik_username: str | None = Header(None, alias="X-Authentik-Username")):
    """Admin endpoints require Authentik auth header (set by proxy) or internal access."""
    if x_authentik_username:
        return x_authentik_username
    # Allow if no auth header present — internal ingress doesn't add it,
    # and we want admin to work from within the cluster
    return "internal"


@router.post("/backfill-frequency")
async def backfill_frequency(
    limit: int = 500,
    db: Session = Depends(get_db),
):
    recordings = (
        db.query(Recording)
        .filter(
            Recording.frequency_hz.isnot(None),
            Recording.frequency_label.is_(None),
        )
        .limit(limit)
        .all()
    )
    updated = 0
    for rec in recordings:
        before_label = rec.frequency_label
        before_repeater = rec.repeater_id
        maybe_set_frequency_metadata(db, rec)
        if rec.frequency_label != before_label or rec.repeater_id != before_repeater:
            updated += 1
    db.commit()
    return {"scanned": len(recordings), "updated": updated}


@router.post("/backfill-ai-tags")
async def backfill_ai_tags(
    limit: int = 200,
    db: Session = Depends(get_db),
):
    recordings = (
        db.query(Recording)
        .filter(
            Recording.transcript.isnot(None),
            Recording.ai_tags.is_(None),
        )
        .order_by(Recording.id.asc())
        .limit(limit)
        .all()
    )
    updated = 0
    ollama_budget = {"remaining": limit if settings.ollama_enabled else 0}
    hamdb_budget = {"remaining": max(limit, settings.hamdb_max_per_cycle)}
    for rec in recordings:
        before_tags = rec.ai_tags
        maybe_set_frequency_metadata(db, rec)
        maybe_set_ai_tags(db, rec, rec.transcript, ollama_budget, hamdb_budget)
        if rec.ai_tags != before_tags:
            updated += 1
    db.commit()
    return {
        "scanned": len(recordings),
        "updated": updated,
        "ollama_remaining": ollama_budget["remaining"],
        "hamdb_remaining": hamdb_budget["remaining"],
    }


@router.post("/sync-repeaters")
async def trigger_repeater_sync():
    asyncio.create_task(asyncio.to_thread(sync_repeaters))
    return {"status": "sync started"}


@router.get("/status")
async def get_status(db: Session = Depends(get_db)):
    total_repeaters = db.query(func.count(Repeater.id)).scalar() or 0
    last_synced = db.query(func.max(Repeater.last_synced)).scalar()
    by_state = (
        db.query(Repeater.state, func.count(Repeater.id))
        .filter(Repeater.state.isnot(None))
        .group_by(Repeater.state)
        .order_by(func.count(Repeater.id).desc())
        .all()
    )
    total_recordings = db.query(func.count(Recording.id)).scalar() or 0
    pending_freq = (
        db.query(func.count(Recording.id))
        .filter(
            Recording.frequency_hz.isnot(None),
            Recording.frequency_label.is_(None),
        )
        .scalar() or 0
    )
    pending_tags = (
        db.query(func.count(Recording.id))
        .filter(Recording.ai_tags.is_(None), Recording.transcript.isnot(None))
        .scalar() or 0
    )
    pending_transcripts = (
        db.query(func.count(Recording.id))
        .filter(
            Recording.mode.in_(["voice", "cw"]),
            Recording.transcript.is_(None),
        )
        .scalar() or 0
    )
    sdr_last_seen_seconds = None
    try:
        wav_files = _glob.glob(os.path.join(settings.audio_base_path, "voice", "*.wav"))
        if wav_files:
            newest_mtime = max(os.path.getmtime(f) for f in wav_files)
            sdr_last_seen_seconds = int(_time.time() - newest_mtime)
    except Exception:
        pass
    return {
        "total_repeaters": total_repeaters,
        "last_repeater_sync": last_synced.isoformat() if last_synced else None,
        "repeaters_by_state": {state: cnt for state, cnt in by_state},
        "total_recordings": total_recordings,
        "pending_freq_label": pending_freq,
        "pending_ai_tags": pending_tags,
        "pending_transcripts": pending_transcripts,
        "sdr_last_seen_seconds": sdr_last_seen_seconds,
    }


@router.get("/alerts")
async def list_alerts(
    limit: int = 100,
    db: Session = Depends(get_db),
):
    rows = (
        db.query(AlertHistory)
        .order_by(AlertHistory.timestamp.desc())
        .limit(limit)
        .all()
    )
    return {
        "total": db.query(func.count(AlertHistory.id)).scalar() or 0,
        "items": [
            {
                "id": r.id,
                "timestamp": r.timestamp.isoformat() if r.timestamp else None,
                "recording_id": r.recording_id,
                "filename": r.filename,
                "frequency_hz": r.frequency_hz,
                "frequency_label": r.frequency_label,
                "transcript_excerpt": r.transcript_excerpt,
                "matched": json.loads(r.matched) if r.matched else [],
            }
            for r in rows
        ],
    }


@router.post("/alerts/{alert_id}/resend")
async def resend_alert(alert_id: int, db: Session = Depends(get_db)):
    """Re-fire the webhook for a specific alert history entry."""
    ah = db.query(AlertHistory).filter(AlertHistory.id == alert_id).first()
    if not ah:
        raise HTTPException(status_code=404, detail="Alert not found")
    if not settings.alert_webhook_url:
        raise HTTPException(status_code=400, detail="No webhook URL configured")

    payload = {
        "recording_id": ah.recording_id,
        "filename": ah.filename,
        "frequency_hz": ah.frequency_hz,
        "frequency_label": ah.frequency_label,
        "timestamp": ah.timestamp.isoformat() if ah.timestamp else None,
        "transcript": ah.transcript_excerpt,
        "matched": json.loads(ah.matched) if ah.matched else [],
        "resent": True,
    }
    _send_webhook(payload)
    return {"status": "sent", "alert_id": alert_id}


@router.get("/storage")
async def get_storage():
    def _dir_size(path: str) -> int:
        total = 0
        if not os.path.isdir(path):
            return total
        for dirpath, _, filenames in os.walk(path):
            for f in filenames:
                try:
                    total += os.path.getsize(os.path.join(dirpath, f))
                except OSError:
                    pass
        return total

    def _dir_count(path: str) -> int:
        if not os.path.isdir(path):
            return 0
        return sum(1 for _, _, files in os.walk(path) for _ in files)

    audio_bytes = _dir_size(settings.audio_base_path)
    cache_bytes = _dir_size(settings.cache_path)
    try:
        usage = shutil.disk_usage(settings.audio_base_path)
        free_bytes = usage.free
        total_bytes = usage.total
    except Exception:
        free_bytes = 0
        total_bytes = 0
    return {
        "audio_bytes": audio_bytes,
        "audio_files": _dir_count(settings.audio_base_path),
        "cache_bytes": cache_bytes,
        "free_bytes": free_bytes,
        "total_bytes": total_bytes,
    }


@router.post("/retention")
async def run_retention(
    days: int = 0,
    dry_run: bool = False,
    mode: str | None = None,
    db: Session = Depends(get_db),
    user: str = Depends(_require_auth),
):
    effective_days = days if days > 0 else settings.retention_days
    if effective_days <= 0:
        raise HTTPException(status_code=400, detail="Specify days > 0 or set RETENTION_DAYS env var")
    cutoff = datetime.utcnow() - timedelta(days=effective_days)
    q = db.query(Recording).filter(Recording.timestamp < cutoff)
    if mode:
        q = q.filter(Recording.mode == mode)
    recordings = q.all()
    matched = len(recordings)
    if dry_run:
        return {"days": effective_days, "cutoff": cutoff.isoformat(), "matched": matched, "deleted": 0}
    deleted = 0
    for rec in recordings:
        for path in [rec.audio_path, rec.text_path, rec.waveform_cached, rec.spectrogram_cached]:
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass
        db.delete(rec)
        deleted += 1
    db.commit()
    return {"days": effective_days, "cutoff": cutoff.isoformat(), "matched": matched, "deleted": deleted}


class FrequencyLabelCreate(BaseModel):
    frequency_hz: float
    bandwidth_hz: float = 5000.0
    label: str
    mode: str | None = None
    notes: str | None = None


@router.get("/frequency-labels")
async def list_frequency_labels(db: Session = Depends(get_db)):
    rows = db.query(FrequencyLabel).order_by(FrequencyLabel.frequency_hz).all()
    return {
        "items": [
            {
                "id": r.id,
                "frequency_hz": r.frequency_hz,
                "bandwidth_hz": r.bandwidth_hz,
                "label": r.label,
                "mode": r.mode,
                "notes": r.notes,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
    }


@router.post("/frequency-labels", status_code=201)
async def create_frequency_label(
    body: FrequencyLabelCreate,
    db: Session = Depends(get_db),
):
    if not body.label.strip():
        raise HTTPException(status_code=422, detail="label cannot be empty")
    fl = FrequencyLabel(
        frequency_hz=body.frequency_hz,
        bandwidth_hz=body.bandwidth_hz,
        label=body.label.strip(),
        mode=body.mode,
        notes=body.notes,
    )
    db.add(fl)
    db.commit()
    db.refresh(fl)
    return {
        "id": fl.id,
        "frequency_hz": fl.frequency_hz,
        "bandwidth_hz": fl.bandwidth_hz,
        "label": fl.label,
        "mode": fl.mode,
        "notes": fl.notes,
        "created_at": fl.created_at.isoformat() if fl.created_at else None,
    }


@router.delete("/frequency-labels/{label_id}")
async def delete_frequency_label(label_id: int, db: Session = Depends(get_db), user: str = Depends(_require_auth)):
    fl = db.query(FrequencyLabel).filter(FrequencyLabel.id == label_id).first()
    if not fl:
        raise HTTPException(status_code=404, detail="Frequency label not found")
    db.delete(fl)
    db.commit()
    return {"deleted": label_id}


_VOICE_FREQ_RE = re.compile(r"^(?P<freq>\d+)_\d+\.wav$")
_CW_FREQ_RE = re.compile(r"^cw_(?P<freq>\d+)_\d+\.wav$")
_DETECTIONS_DIR = os.path.join(os.path.dirname(settings.audio_base_path), "detections")
_SDR_HEARTBEAT_FILES = {
    "2m": os.path.join(_DETECTIONS_DIR, "sdr_heartbeat_2m.json"),
    "70cm": os.path.join(_DETECTIONS_DIR, "sdr_heartbeat_70cm.json"),
}


def _extract_recording_freq_hz(path: str) -> int | None:
    name = os.path.basename(path)
    match = _VOICE_FREQ_RE.match(name) or _CW_FREQ_RE.match(name)
    if not match:
        return None
    try:
        return int(match.group("freq"))
    except (TypeError, ValueError):
        return None


def _newest_recording_mtime(min_hz: int | None = None, max_hz: int | None = None) -> float | None:
    newest_mtime = None
    patterns = [
        os.path.join(settings.audio_base_path, "voice", "*.wav"),
        os.path.join(settings.audio_base_path, "cw", "*.wav"),
    ]
    for pattern in patterns:
        for path in _glob.iglob(pattern):
            if min_hz is not None or max_hz is not None:
                freq_hz = _extract_recording_freq_hz(path)
                if freq_hz is None:
                    continue
                if min_hz is not None and freq_hz < min_hz:
                    continue
                if max_hz is not None and freq_hz > max_hz:
                    continue
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if newest_mtime is None or mtime > newest_mtime:
                newest_mtime = mtime
    return newest_mtime


def _read_heartbeat_timestamp(band: str) -> float | None:
    path = _SDR_HEARTBEAT_FILES.get(band)
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        ts = payload.get("timestamp")
        if isinstance(ts, (int, float)):
            return float(ts)
    except Exception:
        return None
    return None


_SDR_POD_LABELS = {
    "2m": "app=unified-sdr",
    "70cm": "app=unified-sdr-70cm",
}


def _get_band_pod_health(band: str) -> dict | None:
    """Best-effort fallback when shared storage is unavailable.

    We prefer heartbeats/files because they represent actual ingest freshness.
    When the API is running in degraded mode without /data, fall back to the
    capture pod's Ready condition so the dashboard can still distinguish a
    healthy 2m recorder from a genuinely broken 70cm path.
    """
    if os.environ.get("SDR_POD_HEALTH_FALLBACK", "").lower() not in {"1", "true", "yes", "on"}:
        return None
    label_selector = _SDR_POD_LABELS.get(band)
    if not label_selector:
        return None

    token_path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    ca_path = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    namespace = os.environ.get("WATCHDOG_NAMESPACE", "sdr-research")
    host = os.environ.get("KUBERNETES_SERVICE_HOST")
    port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
    if not host:
        return None

    try:
        import ssl as _ssl
        import urllib.parse as _urlparse
        import urllib.request as _urlrequest

        with open(token_path, "r", encoding="utf-8") as f:
            token = f.read().strip()

        url = (
            f"https://{host}:{port}/api/v1/namespaces/{namespace}/pods"
            f"?labelSelector={_urlparse.quote(label_selector, safe='=,')}"
        )
        req = _urlrequest.Request(
            url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        ctx = _ssl.create_default_context(cafile=ca_path)
        with _urlrequest.urlopen(req, context=ctx, timeout=2) as resp:
            payload = json.load(resp)
    except Exception:
        return None

    items = payload.get("items") or []
    if not items:
        return {
            "band": band,
            "last_seen_seconds": None,
            "last_seen_at": None,
            "healthy": False,
            "status": "pod_missing",
        }

    for item in items:
        status = item.get("status") or {}
        phase = status.get("phase")
        conditions = status.get("conditions") or []
        ready = any(
            cond.get("type") == "Ready" and cond.get("status") == "True"
            for cond in conditions
        )
        if phase == "Running" and ready:
            return {
                "band": band,
                "last_seen_seconds": None,
                "last_seen_at": None,
                "healthy": True,
                "status": "pod_ready",
            }

    phase = (items[0].get("status") or {}).get("phase", "Unknown")
    return {
        "band": band,
        "last_seen_seconds": None,
        "last_seen_at": None,
        "healthy": False,
        "status": f"pod_{phase.lower()}",
    }


@router.get("/sdr-health")
async def get_sdr_health(band: str | None = None):
    last_seen_seconds = None
    last_seen_at = None
    healthy = False
    status = "no_files"
    band_ranges = {
        "2m": (136_000_000, 174_000_000),
        "70cm": (420_000_000, 470_000_000),
    }
    if band is not None and band not in band_ranges:
        raise HTTPException(status_code=400, detail="band must be one of: 2m, 70cm")
    try:
        heartbeat_ts = None
        if band in band_ranges:
            heartbeat_ts = _read_heartbeat_timestamp(band)
        else:
            heartbeats = [
                ts
                for ts in (_read_heartbeat_timestamp("2m"), _read_heartbeat_timestamp("70cm"))
                if ts is not None
            ]
            if heartbeats:
                heartbeat_ts = max(heartbeats)

        if heartbeat_ts is not None:
            last_seen_seconds = int(_time.time() - heartbeat_ts)
            last_seen_at = datetime.fromtimestamp(heartbeat_ts).isoformat()
            healthy = last_seen_seconds < 300
            status = "ok" if healthy else "stale"
            return {
                "band": band or "all",
                "last_seen_seconds": last_seen_seconds,
                "last_seen_at": last_seen_at,
                "healthy": healthy,
                "status": status,
            }

        min_hz, max_hz = (None, None)
        if band in band_ranges:
            min_hz, max_hz = band_ranges[band]
        newest_mtime = _newest_recording_mtime(min_hz=min_hz, max_hz=max_hz)
        if newest_mtime is not None:
            last_seen_seconds = int(_time.time() - newest_mtime)
            last_seen_at = datetime.fromtimestamp(newest_mtime).isoformat()
            healthy = last_seen_seconds < 300
            status = "ok" if healthy else "stale"
        elif band in band_ranges:
            pod_health = _get_band_pod_health(band)
            if pod_health is not None:
                return pod_health
    except Exception as exc:
        status = f"error: {exc}"
    return {
        "band": band or "all",
        "last_seen_seconds": last_seen_seconds,
        "last_seen_at": last_seen_at,
        "healthy": healthy,
        "status": status,
    }


# Backward-compatible aliases for older UI clients that still poll
# /api/v1/admin/health and /api/v1/admin/health/{band}.
@router.get("/health")
async def get_sdr_health_legacy():
    return await get_sdr_health(None)


@router.get("/health/{band}")
async def get_sdr_health_band_legacy(band: str):
    return await get_sdr_health(band)


@router.get("/radio-status")
async def get_radio_status(db: Session = Depends(get_db)):
    """Per-radio freshness for the watchdog.

    Returns one row per known data source with the seconds since the last
    ingest. The watchdog (sdr-watchdog deployment) polls this every minute
    to decide whether to restart a stalled decoder. Sources with no data
    ever are returned with last_seen_seconds=null."""
    rows = db.execute(_sql_text("""
        SELECT source_sdr, MAX("timestamp") AS last_seen
        FROM recordings
        WHERE source_sdr IS NOT NULL
        GROUP BY source_sdr
    """)).fetchall()
    radios = []
    now = datetime.utcnow()
    for source, last_seen in rows:
        secs = None
        iso = None
        if last_seen is not None:
            secs = int((now - last_seen).total_seconds())
            iso = last_seen.isoformat()
        radios.append({
            "source": source,
            "kind": "recording",
            "last_seen_seconds": secs,
            "last_seen_at": iso,
        })

    # FT8/WSPR spots live in a separate table. Surface them as their own
    # radio source so the watchdog can monitor the HF decoder.
    try:
        spot_row = db.execute(_sql_text("""
            SELECT mode, MAX("timestamp") AS last_seen
            FROM spots
            GROUP BY mode
        """)).fetchall()
        for mode, last_seen in spot_row:
            secs = None
            iso = None
            if last_seen is not None:
                secs = int((now - last_seen).total_seconds())
                iso = last_seen.isoformat()
            radios.append({
                "source": f"spots-{mode}",
                "kind": "spot",
                "last_seen_seconds": secs,
                "last_seen_at": iso,
            })
    except Exception:
        pass

    return {"radios": radios, "now": now.isoformat()}


@router.post("/bulk-retranscribe")
async def bulk_retranscribe(
    clear_no_speech_only: bool = True,
    db: Session = Depends(get_db),
    user: str = Depends(_require_auth),
):
    from ..services.tagging import is_no_speech_transcript
    query = db.query(Recording).filter(
        Recording.mode.in_(["voice", "cw"]),
        Recording.transcript.isnot(None),
    )
    all_recs = query.all()
    if clear_no_speech_only:
        recs = [r for r in all_recs if is_no_speech_transcript(r.transcript)]
    else:
        recs = all_recs
    cleared = 0
    for rec in recs:
        if rec.text_path and os.path.exists(rec.text_path):
            try:
                os.remove(rec.text_path)
            except OSError:
                pass
        rec.transcript = None
        rec.text_path = None
        rec.ai_tags = None
        db.execute(
            _sql_text("UPDATE recordings SET search_vector = NULL WHERE id = :id"),
            {"id": rec.id},
        )
        cleared += 1
    db.commit()
    return {
        "cleared": cleared,
        "mode": "no_speech_only" if clear_no_speech_only else "all_voice_cw",
    }


# ---------------------------------------------------------------------------
# Alert rules (DB-backed keyword / callsign watches)
# ---------------------------------------------------------------------------

def _ensure_alert_rules(db):
    db.execute(_sql_text("""
        CREATE TABLE IF NOT EXISTS alert_rules (
            id SERIAL PRIMARY KEY,
            rule_type TEXT NOT NULL,
            value TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            notes TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    """))
    db.commit()


class AlertRuleCreate(BaseModel):
    rule_type: str   # 'keyword' or 'callsign'
    value: str
    notes: str | None = None


@router.get("/alert-rules")
async def list_alert_rules(db: Session = Depends(get_db)):
    _ensure_alert_rules(db)
    rows = db.execute(_sql_text(
        "SELECT id, rule_type, value, enabled, notes, created_at"
        " FROM alert_rules ORDER BY created_at DESC"
    )).fetchall()
    return {"items": [dict(r._mapping) for r in rows]}


@router.post("/alert-rules", status_code=201)
async def create_alert_rule(body: AlertRuleCreate, db: Session = Depends(get_db)):
    if body.rule_type not in ("keyword", "callsign"):
        raise HTTPException(status_code=422, detail="rule_type must be 'keyword' or 'callsign'")
    if not body.value.strip():
        raise HTTPException(status_code=422, detail="value cannot be empty")
    _ensure_alert_rules(db)
    val = (body.value.strip().upper() if body.rule_type == "callsign"
           else body.value.strip().lower())
    row = db.execute(
        _sql_text(
            "INSERT INTO alert_rules (rule_type, value, notes)"
            " VALUES (:rt, :v, :n)"
            " RETURNING id, rule_type, value, enabled, notes, created_at"
        ),
        {"rt": body.rule_type, "v": val, "n": body.notes},
    ).first()
    db.commit()
    return dict(row._mapping)


@router.patch("/alert-rules/{rule_id}")
async def toggle_alert_rule(rule_id: int, enabled: bool, db: Session = Depends(get_db)):
    _ensure_alert_rules(db)
    res = db.execute(
        _sql_text("UPDATE alert_rules SET enabled = :e WHERE id = :id RETURNING id"),
        {"e": enabled, "id": rule_id},
    ).first()
    if not res:
        raise HTTPException(status_code=404, detail="Rule not found")
    db.commit()
    return {"id": rule_id, "enabled": enabled}


@router.delete("/alert-rules/{rule_id}")
async def delete_alert_rule(rule_id: int, db: Session = Depends(get_db)):
    _ensure_alert_rules(db)
    res = db.execute(
        _sql_text("DELETE FROM alert_rules WHERE id = :id RETURNING id"),
        {"id": rule_id},
    ).first()
    if not res:
        raise HTTPException(status_code=404, detail="Rule not found")
    db.commit()
    return {"deleted": rule_id}


@router.post("/test-webhook")
async def test_webhook():
    """Send a test payload to the configured alert webhook URL."""
    if not settings.alert_webhook_url:
        raise HTTPException(status_code=400, detail="ALERT_WEBHOOK_URL is not configured")
    _send_webhook({
        "recording_id": 0,
        "filename": "test_webhook.wav",
        "mode": "voice",
        "frequency_hz": 145230000.0,
        "frequency_label": "Test signal",
        "timestamp": datetime.utcnow().isoformat(),
        "duration_seconds": 0.0,
        "transcript": "This is a test webhook from the SDR admin panel.",
        "matched": ["keyword:test"],
    })
    return {"message": f"Test webhook sent to {settings.alert_webhook_url}"}


@router.get("/alert-dryrun")
async def alert_dryrun(limit: int = 500, db: Session = Depends(get_db)):
    """Check recent recordings against active alert rules without sending webhooks."""
    import re as _re
    from ..services.alerting import _get_rules
    keywords, callsigns = _get_rules(db)
    recordings = (
        db.query(Recording)
        .filter(Recording.transcript.isnot(None), Recording.transcript != "")
        .order_by(Recording.timestamp.desc())
        .limit(limit)
        .all()
    )
    matches = []
    for rec in recordings:
        transcript_lower = rec.transcript.lower()
        callsign_upper = _re.sub(r"[^A-Z0-9]", "", rec.transcript.upper())
        matched = []
        for kw in keywords:
            if kw in transcript_lower:
                matched.append(f"keyword:{kw}")
        for cs in callsigns:
            if cs in callsign_upper:
                matched.append(f"callsign:{cs}")
        if matched:
            matches.append({
                "id": rec.id,
                "filename": rec.filename,
                "mode": rec.mode,
                "frequency_hz": rec.frequency_hz,
                "frequency_label": rec.frequency_label,
                "timestamp": rec.timestamp.isoformat() if rec.timestamp else None,
                "transcript_excerpt": (rec.transcript or "")[:200],
                "matched_rules": matched,
            })
    return {
        "rules": {"keywords": keywords, "callsigns": callsigns},
        "matches": matches,
        "total": len(matches),
    }

_last_digest_sent: datetime | None = None


@router.get("/digest-status")
async def get_digest_status():
    """Return the timestamp of the last sent daily digest."""
    return {
        "last_sent": _last_digest_sent.isoformat() if _last_digest_sent else None,
    }


@router.post("/send-digest")
async def send_digest_now(db: Session = Depends(get_db)):
    """Manually trigger a daily digest webhook."""
    global _last_digest_sent
    _send_daily_digest()
    _last_digest_sent = datetime.utcnow()
    return {"status": "sent", "sent_at": _last_digest_sent.isoformat()}


# ---------------------------------------------------------------------------
# Solar propagation data (NOAA SWPC)
# ---------------------------------------------------------------------------

_propagation_cache: dict = {}
_PROPAGATION_TTL = 900  # 15 minutes

_NOAA_SOLAR_WIND = "https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json"
_NOAA_K_INDEX_FORECAST = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"
_NOAA_SOLAR_FLUX = "https://services.swpc.noaa.gov/products/summary/10cm-flux.json"


def _derive_hf_conditions(sfi: float | None, k: float | None) -> dict:
    """Derive HF band conditions from Solar Flux Index and K-index."""
    if sfi is None or k is None:
        return {"80m-40m": "Unknown", "30m-20m": "Unknown", "17m-10m": "Unknown"}
    if sfi > 150 and k < 4:
        return {"80m-40m": "Excellent", "30m-20m": "Excellent", "17m-10m": "Excellent"}
    if sfi > 100 and k < 4:
        return {"80m-40m": "Good", "30m-20m": "Good", "17m-10m": "Good"}
    if sfi > 70 and k < 5:
        return {"80m-40m": "Fair", "30m-20m": "Fair", "17m-10m": "Poor"}
    return {"80m-40m": "Poor", "30m-20m": "Poor", "17m-10m": "Poor"}


async def _fetch_propagation_data() -> dict:
    """Fetch solar propagation data from NOAA SWPC APIs."""
    result = {
        "solar_flux_index": None,
        "k_index": None,
        "k_index_forecast": [],
        "bz": None,
        "bt": None,
        "hf_conditions": {"80m-40m": "Unknown", "30m-20m": "Unknown", "17m-10m": "Unknown"},
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "cached": False,
    }

    def _fetch_url(url):
        req = urllib.request.Request(url, headers={"User-Agent": "SDRViewer/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())

    # Fetch solar wind magnetic field (Bz, Bt)
    try:
        data = _fetch_url(_NOAA_SOLAR_WIND)
        for key in ("Bz", "Bt"):
            if data.get(key) is not None:
                try:
                    result[key.lower()] = float(data[key])
                except (ValueError, TypeError):
                    pass
    except Exception:
        pass

    # Fetch solar flux index (SFI / 10.7cm flux)
    try:
        data = _fetch_url(_NOAA_SOLAR_FLUX)
        if data.get("Flux") is not None:
            try:
                result["solar_flux_index"] = float(data["Flux"])
            except (ValueError, TypeError):
                pass
    except Exception:
        pass

    # Fetch K-index forecast
    try:
        rows = _fetch_url(_NOAA_K_INDEX_FORECAST)
        k_values = []
        for row in rows:
            if not isinstance(row, list) or len(row) < 2 or row[0] == "time_tag":
                continue
            try:
                k_values.append(float(row[1]))
            except (ValueError, TypeError):
                continue
        if k_values:
            result["k_index"] = k_values[0]
            result["k_index_forecast"] = k_values[:8]
    except Exception:
        pass

    result["hf_conditions"] = _derive_hf_conditions(
        result["solar_flux_index"], result["k_index"]
    )
    return result


@router.get("/propagation")
async def get_propagation():
    """Return solar propagation data from NOAA SWPC, cached for 15 minutes."""
    global _propagation_cache
    now = _time.monotonic()
    if (
        _propagation_cache.get("ts") is not None
        and now - _propagation_cache["ts"] < _PROPAGATION_TTL
        and _propagation_cache.get("data")
    ):
        cached = dict(_propagation_cache["data"])
        cached["cached"] = True
        return cached

    try:
        data = await _fetch_propagation_data()
        _propagation_cache = {"ts": now, "data": data}
        return data
    except Exception:
        # If fetch fails entirely, return stale cache if available
        if _propagation_cache.get("data"):
            cached = dict(_propagation_cache["data"])
            cached["cached"] = True
            return cached
        return {
            "solar_flux_index": None,
            "k_index": None,
            "k_index_forecast": [],
            "bz": None,
            "bt": None,
            "hf_conditions": {
                "80m-40m": "Unknown",
                "30m-20m": "Unknown",
                "17m-10m": "Unknown",
            },
            "fetched_at": None,
            "cached": False,
            "error": "Failed to fetch NOAA data",
        }


# ---------------------------------------------------------------------------
# Satellite pass prediction — TLE data + frequencies for ham satellites
# ---------------------------------------------------------------------------

_HAM_SATELLITES = [
    {"norad_id": 25544, "name": "ISS (ZARYA)", "frequencies": [
        {"mhz": 145.800, "mode": "FM Voice/APRS", "direction": "downlink"},
        {"mhz": 437.800, "mode": "SSTV", "direction": "downlink"},
    ]},
    {"norad_id": 25338, "name": "NOAA-15", "frequencies": [
        {"mhz": 137.620, "mode": "APT", "direction": "downlink"},
    ]},
    {"norad_id": 28654, "name": "NOAA-18", "frequencies": [
        {"mhz": 137.9125, "mode": "APT", "direction": "downlink"},
    ]},
    {"norad_id": 33591, "name": "NOAA-19", "frequencies": [
        {"mhz": 137.100, "mode": "APT", "direction": "downlink"},
    ]},
    {"norad_id": 43013, "name": "NOAA-20 (JPSS-1)", "frequencies": [
        {"mhz": 137.200, "mode": "APT", "direction": "downlink"},
    ]},
    {"norad_id": 43017, "name": "AO-91 (Fox-1B)", "frequencies": [
        {"mhz": 145.960, "mode": "FM Uplink", "direction": "uplink"},
        {"mhz": 435.250, "mode": "FM Downlink", "direction": "downlink"},
    ]},
    {"norad_id": 27607, "name": "SO-50 (SaudiSat-1C)", "frequencies": [
        {"mhz": 145.850, "mode": "FM Uplink", "direction": "uplink"},
        {"mhz": 436.795, "mode": "FM Downlink", "direction": "downlink"},
    ]},
    {"norad_id": 48274, "name": "CSS (Tianhe)", "frequencies": [
        {"mhz": 437.550, "mode": "Telemetry", "direction": "downlink"},
    ]},
    {"norad_id": 7530,  "name": "AMSAT-OSCAR 7", "frequencies": [
        {"mhz": 145.950, "mode": "CW Beacon", "direction": "downlink"},
        {"mhz": 29.502,  "mode": "SSB/CW Transponder", "direction": "downlink"},
    ]},
    {"norad_id": 54684, "name": "TEVEL-3", "frequencies": [
        {"mhz": 436.400, "mode": "FM Transponder", "direction": "downlink"},
    ]},
]

_tle_cache: dict = {}
_TLE_CACHE_TTL = 21600  # 6 hours


async def _fetch_satellite_tles() -> list[dict]:
    """Fetch TLE data for ham satellites from Celestrak, cached for 6 hours."""
    now = _time.monotonic()
    if (
        _tle_cache.get("ts") is not None
        and now - _tle_cache["ts"] < _TLE_CACHE_TTL
        and _tle_cache.get("data")
    ):
        return _tle_cache["data"]

    results = []
    for sat_info in _HAM_SATELLITES:
        norad_id = sat_info["norad_id"]
        try:
            url = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={norad_id}&FORMAT=TLE"
            req = urllib.request.Request(url, headers={"User-Agent": "SDRViewer/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode().strip()
            lines = [l.strip() for l in text.split("\n") if l.strip()]
            if len(lines) < 3 or not lines[1].startswith("1 ") or not lines[2].startswith("2 "):
                continue
            results.append({
                "norad_id": norad_id,
                "name": sat_info["name"],
                "tle_name": lines[0],
                "tle_line1": lines[1],
                "tle_line2": lines[2],
                "frequencies": sat_info["frequencies"],
            })
        except Exception:
            continue

    if results:
        _tle_cache["ts"] = now
        _tle_cache["data"] = results
    elif _tle_cache.get("data"):
        return _tle_cache["data"]

    return results


@router.get("/satellite-passes")
async def get_satellite_passes(hours: int = 24, min_elevation: float = 10.0):
    """Return TLE data and frequencies for ham satellites.
    Pass prediction is computed client-side using satellite.js.
    """
    lat = settings.repeaterbook_latitude
    lng = settings.repeaterbook_longitude
    station = {"latitude": float(lat) if lat else None, "longitude": float(lng) if lng else None}

    satellites = await _fetch_satellite_tles()

    return {
        "station": station,
        "hours": hours,
        "min_elevation": min_elevation,
        "satellites": satellites,
    }


# ---------------------------------------------------------------------------
# Live spectrum / FFT detection data
# ---------------------------------------------------------------------------

@router.get("/spectrum")
async def get_spectrum(capture_id: str | None = None):
    """Return latest FFT detection data from unified-sdr.

    Reads all detections_*.json files from the detections directory.
    Optionally filter by capture_id (e.g. '2m', '70cm', 'pager').
    Returns a list of capture snapshots with center_freq, noise_floor,
    and detected peaks.
    """
    pattern = os.path.join(_DETECTIONS_DIR, "detections_*.json")
    files = sorted(
        _glob.glob(pattern), key=os.path.getmtime, reverse=True
    )
    if not files:
        return {"captures": [], "error": "no detection data found"}

    now = _time.time()
    captures = []
    for path in files:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue

        cid = data.get("capture_id", "unknown")
        if capture_id and cid != capture_id:
            continue

        ts = data.get("timestamp", 0)
        age = now - ts if ts else 9999

        detections = data.get("detections", [])
        # Sort detections by frequency
        detections.sort(key=lambda d: d.get("frequency_hz", 0))

        captures.append({
            "capture_id": cid,
            "center_freq_hz": data.get("center_freq_hz", 0),
            "sample_rate": data.get("sample_rate", 0),
            "noise_floor_db": data.get("noise_floor_db"),
            "timestamp": ts,
            "age_seconds": round(age, 1),
            "stale": age > 30,
            "detections": [
                {
                    "frequency_hz": d.get("frequency_hz", 0),
                    "power_db": d.get("power_db", 0),
                    "bandwidth_hz": d.get("bandwidth_hz", 0),
                    "mode": d.get("mode", "unknown"),
                    "recording": d.get("recording", False),
                }
                for d in detections
            ],
        })

    return {"captures": captures}
