"""RepeaterBook integration — periodic sync and per-recording frequency lookup."""

import asyncio
import json
import os
from datetime import datetime
from typing import Optional
from urllib import error, request

from sqlalchemy import text

from ..config import settings
from ..database import SessionLocal
from ..models import Repeater

FREQ_TOLERANCE_HZ = 6_000
REPEATERBOOK_URL = (
    "https://www.repeaterbook.com/api/export.php"
    "?country=US&state={state}&lat={lat}&lng={lng}"
    "&distance={radius}&Dunit=m&status_id=1&use=OPEN&format=json"
)


def _auth_headers() -> dict:
    ua = os.getenv("REPEATERBOOK_USER_AGENT", "sdr-research-oss/1.0 (operator@example.com)").strip()
    api_key = os.getenv("REPEATERBOOK_API_KEY", "").strip()
    headers = {"User-Agent": ua}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _mhz_to_hz(value: str) -> Optional[float]:
    try:
        return float(value) * 1_000_000
    except (ValueError, TypeError):
        return None


def _parse_pl(value: str) -> Optional[float]:
    try:
        f = float(value)
        return f if f > 0 else None
    except (ValueError, TypeError):
        return None


def _digital_modes(row: dict) -> Optional[str]:
    modes = []
    for key in ("DMR", "D-Star", "System Fusion", "P25", "NXDN", "TETRA"):
        if str(row.get(key, "No")).strip().lower() == "yes":
            modes.append(key)
    return ",".join(modes) if modes else None


def _linked_nodes(row: dict) -> Optional[str]:
    parts = []
    if row.get("EchoLink Node", "").strip():
        parts.append(f"EchoLink:{row['EchoLink Node'].strip()}")
    if row.get("IRLP Node", "").strip():
        parts.append(f"IRLP:{row['IRLP Node'].strip()}")
    if row.get("AllStarLink Node", "").strip():
        parts.append(f"AllStar:{row['AllStarLink Node'].strip()}")
    if row.get("WiresX", "").strip():
        parts.append(f"WiresX:{row['WiresX'].strip()}")
    return " ".join(parts) if parts else None


def fetch_repeaterbook() -> list[dict]:
    all_results: list[dict] = []
    headers = _auth_headers()
    for state in settings.repeaterbook_states.split(","):
        state = state.strip()
        if not state:
            continue
        url = REPEATERBOOK_URL.format(
            state=state,
            lat=settings.repeaterbook_latitude,
            lng=settings.repeaterbook_longitude,
            radius=settings.repeaterbook_radius_miles,
        )
        req = request.Request(url, headers=headers)
        try:
            with request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8", errors="ignore")
        except error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="ignore")[:200]
            except Exception:
                pass
            print(f"[RepeaterBook] HTTP {exc.code} for {state}: {detail}")
            continue
        except error.URLError as exc:
            print(f"[RepeaterBook] Fetch failed for {state}: {exc}")
            continue
        try:
            data = json.loads(body)
            if isinstance(data, dict) and data.get("ok") is False:
                print(f"[RepeaterBook] API error for {state}: {data}")
                continue
            results = data.get("results", []) or []
            all_results.extend(results)
            print(f"[RepeaterBook] {state}: {len(results)} repeaters")
        except Exception as exc:
            print(f"[RepeaterBook] JSON parse failed for {state}: {exc}")
    return all_results


def sync_repeaters():
    if not settings.repeaterbook_enabled:
        return
    print("[RepeaterBook] Syncing repeaters…")
    rows = fetch_repeaterbook()
    if not rows:
        print("[RepeaterBook] No results returned.")
        return
    db = SessionLocal()
    try:
        upserted = 0
        now = datetime.utcnow()
        for row in rows:
            callsign = str(row.get("Call", "")).strip().upper()
            freq_hz = _mhz_to_hz(row.get("Frequency", ""))
            if not callsign or not freq_hz:
                continue
            existing = (
                db.query(Repeater)
                .filter(Repeater.callsign == callsign, Repeater.frequency_hz == freq_hz)
                .first()
            )
            if existing is None:
                existing = Repeater(callsign=callsign, frequency_hz=freq_hz)
                db.add(existing)
            existing.input_hz = _mhz_to_hz(row.get("Input Freq", ""))
            existing.pl_tone = _parse_pl(row.get("PL", ""))
            existing.location = str(row.get("Location", "")).strip() or None
            existing.county = str(row.get("County", "")).strip() or None
            existing.state = str(row.get("ST", row.get("State", ""))).strip() or None
            existing.latitude = float(row.get("Latitude", 0)) if row.get("Latitude") else None
            existing.longitude = float(row.get("Longitude", 0)) if row.get("Longitude") else None
            existing.use = str(row.get("Use", "")).strip() or None
            existing.digital_modes = _digital_modes(row)
            existing.linked_nodes = _linked_nodes(row)
            existing.last_synced = now
            upserted += 1
        db.commit()
        print(f"[RepeaterBook] Upserted {upserted} repeaters.")
    except Exception as exc:
        print(f"[RepeaterBook] Sync error: {exc}")
        db.rollback()
    finally:
        db.close()


def lookup_repeater(db, frequency_hz: float) -> Optional[Repeater]:
    return (
        db.query(Repeater)
        .filter(
            Repeater.frequency_hz >= frequency_hz - FREQ_TOLERANCE_HZ,
            Repeater.frequency_hz <= frequency_hz + FREQ_TOLERANCE_HZ,
        )
        .order_by(text("ABS(frequency_hz - :f)").bindparams(f=frequency_hz))
        .first()
    )


def repeater_label(repeater: Repeater) -> str:
    parts = [f"{repeater.callsign} Rptr"]
    if repeater.location:
        parts.append(repeater.location)
    if repeater.state:
        parts.append(repeater.state)
    return " — ".join(parts)


def repeater_tags(repeater: Repeater) -> list[str]:
    tags = [repeater.callsign]
    if repeater.digital_modes:
        for mode in repeater.digital_modes.split(","):
            tags.append(mode.strip().lower().replace("-", "_").replace(" ", "_"))
    if repeater.linked_nodes:
        for node in repeater.linked_nodes.split():
            prefix = node.split(":")[0].lower()
            tags.append(prefix)
    return tags


async def run_repeater_sync():
    if not settings.repeaterbook_enabled:
        return
    await asyncio.to_thread(sync_repeaters)
    interval_sec = settings.repeaterbook_sync_hours * 3600
    while True:
        await asyncio.sleep(interval_sec)
        await asyncio.to_thread(sync_repeaters)
