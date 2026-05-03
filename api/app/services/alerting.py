"""
Webhook alerting for recordings that match watched callsigns or keywords.

Rules source (in priority order):
  1. DB table `alert_rules` (if any rows exist) — editable via Admin UI
  2. ALERT_KEYWORDS / ALERT_CALLSIGNS env vars (fallback)

Dedup: checks AlertHistory DB table first (survives restarts), then warms
the in-process set to avoid repeated DB queries within the same lifecycle.
"""

import json
import re
from urllib import error, request as urllib_request

from ..config import settings

_alerted: set[int] = set()


def _keywords() -> list[str]:
    return [k.strip().lower() for k in settings.alert_keywords.split(",") if k.strip()]


def _callsigns() -> list[str]:
    return [c.strip().upper() for c in settings.alert_callsigns.split(",") if c.strip()]


def _get_rules(db=None):
    """Return (keywords, callsigns) — from DB if rules exist, else env vars."""
    if db is not None:
        try:
            from sqlalchemy import text as _text
            rows = db.execute(
                _text("SELECT rule_type, value FROM alert_rules WHERE enabled = true")
            ).fetchall()
            if rows:
                kw = [r.value.lower() for r in rows if r.rule_type == "keyword"]
                cs = [r.value.upper() for r in rows if r.rule_type == "callsign"]
                return kw, cs
        except Exception:
            pass
    return _keywords(), _callsigns()


def _send_webhook(payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(
        settings.alert_webhook_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=10):
            pass
    except error.URLError as exc:
        print(f"[Alert] Webhook delivery failed: {exc}")


def check_alerts(recording, db=None) -> None:
    """Check recording for alert conditions; store to DB and fire webhook if matched."""
    if recording.id in _alerted:
        return

    # Persistent dedup: check AlertHistory in DB (survives pod restarts)
    if db is not None:
        try:
            from ..models import AlertHistory
            if db.query(AlertHistory).filter(
                AlertHistory.recording_id == recording.id
            ).first():
                _alerted.add(recording.id)
                return
        except Exception:
            pass

    if not recording.transcript:
        return

    keywords, callsigns = _get_rules(db)
    transcript_lower = recording.transcript.lower()
    matched: list[str] = []

    for kw in keywords:
        if kw in transcript_lower:
            matched.append(f"keyword:{kw}")

    callsign_upper = re.sub(r"[^A-Z0-9]", "", recording.transcript.upper())
    for cs in callsigns:
        if cs in callsign_upper:
            matched.append(f"callsign:{cs}")

    if not matched:
        return

    _alerted.add(recording.id)

    payload = {
        "recording_id": recording.id,
        "filename": recording.filename,
        "mode": recording.mode,
        "frequency_hz": recording.frequency_hz,
        "frequency_label": recording.frequency_label,
        "timestamp": recording.timestamp.isoformat() if recording.timestamp else None,
        "duration_seconds": recording.duration_seconds,
        "transcript": recording.transcript,
        "matched": matched,
    }

    try:
        from .metrics import alerts_fired as _alerts_fired
        _alerts_fired.inc()
    except Exception:
        pass
    print(f"[Alert] Match for recording {recording.id}: {matched}")

    if db is not None:
        try:
            from ..models import AlertHistory
            ah = AlertHistory(
                recording_id=recording.id,
                filename=recording.filename,
                frequency_hz=recording.frequency_hz,
                frequency_label=recording.frequency_label,
                transcript_excerpt=(recording.transcript or "")[:500],
                matched=json.dumps(matched),
            )
            db.add(ah)
            db.commit()
        except Exception as exc:
            print(f"[Alert] Failed to store alert history: {exc}")
            try:
                db.rollback()
            except Exception:
                pass

    if settings.alert_webhook_url:
        _send_webhook(payload)
