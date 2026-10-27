"""RepeaterBook integration — periodic sync and per-recording frequency lookup."""

import asyncio
import json
import math
import os
import threading
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Optional
from urllib import error, request

from sqlalchemy import text

from ..config import settings
from ..database import SessionLocal
from ..models import Repeater, RepeaterBookSyncState

FREQ_TOLERANCE_HZ = 6_000

# How often the background loop re-evaluates whether a sync is due. Each tick
# only reads the persisted state; it makes no request unless the gate allows.
SCHEDULER_TICK_SEC = 900
# 429 backoff when Retry-After is absent, doubled per consecutive 429.
RATE_LIMIT_BASE_BACKOFF = timedelta(hours=1)
RATE_LIMIT_MAX_BACKOFF = timedelta(days=7)
# API-body error codes treated as rate limiting rather than a denial. Any
# other `ok: false` response is treated as a denial (fail closed).
RATE_LIMIT_ERROR_CODES = {"rate_limited", "rate_limit", "too_many_requests"}

_sync_lock = threading.Lock()


class RepeaterBookDenied(Exception):
    """Auth / authorization / scope / User-Agent denial. Stops all syncing."""

    def __init__(self, http_status: Optional[int], error_code: Optional[str], detail: str):
        super().__init__(f"HTTP {http_status} {error_code or ''}: {detail}".strip())
        self.http_status = http_status
        self.error_code = error_code
        self.detail = detail


class RepeaterBookRateLimited(Exception):
    """HTTP 429 (or 503 with Retry-After). Stops the batch and backs off."""

    def __init__(self, retry_after: Optional[timedelta], detail: str):
        super().__init__(f"rate limited (retry_after={retry_after}): {detail}")
        self.retry_after = retry_after
        self.detail = detail


class RepeaterBookError(Exception):
    """Any other HTTP / network / parse failure. Stops the batch."""


def _utcnow() -> datetime:
    return datetime.utcnow()
# export.php has no proximity search; it filters by FIPS state_id only.
# The configured radius is applied locally in _within_radius().
REPEATERBOOK_URL = "https://www.repeaterbook.com/api/export.php?state_id={state_id}"

STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08",
    "CT": "09", "DE": "10", "DC": "11", "FL": "12", "GA": "13", "HI": "15",
    "ID": "16", "IL": "17", "IN": "18", "IA": "19", "KS": "20", "KY": "21",
    "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27",
    "MS": "28", "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33",
    "NJ": "34", "NM": "35", "NY": "36", "NC": "37", "ND": "38", "OH": "39",
    "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46",
    "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53",
    "WV": "54", "WI": "55", "WY": "56", "PR": "72",
}


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


def _parse_coord(value) -> Optional[float]:
    try:
        f = float(value)
    except (ValueError, TypeError):
        return None
    return f if f != 0 else None


def _within_radius(lat: Optional[float], lon: Optional[float]) -> bool:
    if lat is None or lon is None:
        return False
    lat0, lon0 = settings.repeaterbook_latitude, settings.repeaterbook_longitude
    p1, p2 = math.radians(lat0), math.radians(lat)
    dp, dl = p2 - p1, math.radians(lon - lon0)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    miles = 3958.8 * 2 * math.asin(math.sqrt(a))
    return miles <= settings.repeaterbook_radius_miles


def _digital_modes(row: dict) -> Optional[str]:
    modes = []
    for key, label in (
        ("DMR", "DMR"), ("D-Star", "D-Star"), ("System Fusion", "System Fusion"),
        ("APCO P-25", "APCO P-25"), ("NXDN", "NXDN"), ("Tetra", "Tetra"), ("M17", "M17"),
    ):
        if str(row.get(key, "No")).strip().lower() == "yes":
            modes.append(label)
    return ",".join(modes) if modes else None


def _linked_nodes(row: dict) -> Optional[str]:
    parts = []
    if row.get("EchoLink Node", "").strip():
        parts.append(f"EchoLink:{row['EchoLink Node'].strip()}")
    if row.get("IRLP Node", "").strip():
        parts.append(f"IRLP:{row['IRLP Node'].strip()}")
    if row.get("AllStar Node", "").strip():
        parts.append(f"AllStar:{row['AllStar Node'].strip()}")
    if row.get("Wires Node", "").strip():
        parts.append(f"WiresX:{row['Wires Node'].strip()}")
    return " ".join(parts) if parts else None


def _parse_retry_after(value: Optional[str], now: datetime) -> Optional[timedelta]:
    """Retry-After is either delta-seconds or an HTTP-date."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return timedelta(seconds=int(value))
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is not None:
        when = when.astimezone(timezone.utc).replace(tzinfo=None)
    return max(when - now, timedelta(0))


def _error_body(exc: error.HTTPError) -> tuple[str, Optional[str]]:
    detail = ""
    try:
        detail = exc.read().decode("utf-8", errors="ignore")[:500]
    except Exception:
        pass
    code = None
    try:
        data = json.loads(detail)
        if isinstance(data, dict):
            code = data.get("error_code")
    except (ValueError, TypeError):
        pass
    return detail, code


def _fetch_state(state: str, headers: dict) -> list[dict]:
    """Fetch one state. Raises on any failure — callers must not continue."""
    fips = STATE_FIPS.get(state.upper())
    if fips is None:
        raise RepeaterBookError(f"Unknown state {state!r} in REPEATERBOOK_STATES")
    url = REPEATERBOOK_URL.format(state_id=fips)
    req = request.Request(url, headers=headers)
    try:
        with request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
    except error.HTTPError as exc:
        detail, code = _error_body(exc)
        if exc.code in (401, 403):
            raise RepeaterBookDenied(exc.code, code, detail) from exc
        retry_after = _parse_retry_after(exc.headers.get("Retry-After") if exc.headers else None, _utcnow())
        if exc.code == 429 or (exc.code == 503 and retry_after is not None):
            raise RepeaterBookRateLimited(retry_after, detail) from exc
        raise RepeaterBookError(f"HTTP {exc.code} for {state}: {detail[:200]}") from exc
    except error.URLError as exc:
        raise RepeaterBookError(f"Fetch failed for {state}: {exc}") from exc
    try:
        data = json.loads(body)
    except ValueError as exc:
        raise RepeaterBookError(f"JSON parse failed for {state}: {exc}") from exc
    if not isinstance(data, dict):
        raise RepeaterBookError(f"Unexpected response for {state}: {type(data).__name__}")
    if data.get("ok") is False:
        code = data.get("error_code")
        if code in RATE_LIMIT_ERROR_CODES:
            raise RepeaterBookRateLimited(None, json.dumps(data)[:500])
        raise RepeaterBookDenied(None, code, json.dumps(data)[:500])
    results = data.get("results", []) or []
    print(f"[RepeaterBook] {state}: {len(results)} repeaters")
    return results


def fetch_repeaterbook() -> list[dict]:
    """Fetch every configured state. The first failure aborts the whole batch."""
    all_results: list[dict] = []
    headers = _auth_headers()
    for state in settings.repeaterbook_states.split(","):
        state = state.strip()
        if not state:
            continue
        all_results.extend(_fetch_state(state, headers))
    return all_results


# ---------------------------------------------------------------------------
# Persistent sync state / gate
# ---------------------------------------------------------------------------

def _load_state(db) -> RepeaterBookSyncState:
    state = db.get(RepeaterBookSyncState, 1)
    if state is None:
        state = RepeaterBookSyncState(id=1, blocked=False, consecutive_rate_limits=0)
        db.add(state)
        db.flush()
    return state


def _gate_reason(state: RepeaterBookSyncState, now: datetime, trigger: str) -> Optional[str]:
    """Return why a sync must not run now, or None if it may."""
    if state.blocked:
        return (
            f"blocked since {state.blocked_at} after denial "
            f"(HTTP {state.block_http_status}, {state.block_error_code}); "
            "operator must correct the cause and clear the block"
        )
    if state.backoff_until and now < state.backoff_until:
        return f"rate-limit backoff until {state.backoff_until} UTC"
    if trigger != "manual" and state.last_attempt_at is not None:
        due = state.last_attempt_at + timedelta(hours=settings.repeaterbook_sync_hours)
        if now < due:
            return f"not due until {due} UTC"
    return None


def repeaterbook_status() -> dict:
    db = SessionLocal()
    try:
        state = _load_state(db)
        db.commit()
        return {
            "enabled": settings.repeaterbook_enabled,
            "blocked": state.blocked,
            "blocked_at": state.blocked_at.isoformat() if state.blocked_at else None,
            "block_http_status": state.block_http_status,
            "block_error_code": state.block_error_code,
            "backoff_until": state.backoff_until.isoformat() if state.backoff_until else None,
            "consecutive_rate_limits": state.consecutive_rate_limits,
            "last_attempt_at": state.last_attempt_at.isoformat() if state.last_attempt_at else None,
            "last_success_at": state.last_success_at.isoformat() if state.last_success_at else None,
            "last_error": state.last_error,
            "manual_sync_blocked_reason": _gate_reason(state, _utcnow(), "manual"),
        }
    finally:
        db.close()


def clear_repeaterbook_block(cleared_by: str) -> dict:
    """Operator action: clear a denial block once the cause is corrected.

    Does not clear an active 429 backoff.
    """
    db = SessionLocal()
    try:
        state = _load_state(db)
        was = state.blocked
        state.blocked = False
        state.blocked_at = None
        state.block_http_status = None
        state.block_error_code = None
        state.block_detail = None
        db.commit()
        print(f"[RepeaterBook] Denial block cleared by {cleared_by} (was_blocked={was}).")
        return {"cleared": was}
    finally:
        db.close()


def _record_denial(exc: RepeaterBookDenied) -> None:
    db = SessionLocal()
    try:
        state = _load_state(db)
        state.blocked = True
        state.blocked_at = _utcnow()
        state.block_http_status = exc.http_status
        state.block_error_code = (exc.error_code or "")[:100] or None
        state.block_detail = exc.detail
        state.last_error = str(exc)[:1000]
        db.commit()
    finally:
        db.close()


def _record_rate_limit(exc: RepeaterBookRateLimited) -> datetime:
    db = SessionLocal()
    try:
        state = _load_state(db)
        state.consecutive_rate_limits = (state.consecutive_rate_limits or 0) + 1
        exponential = min(
            RATE_LIMIT_BASE_BACKOFF * (2 ** (state.consecutive_rate_limits - 1)),
            RATE_LIMIT_MAX_BACKOFF,
        )
        # Never shorter than what the server asked for.
        delay = max(exc.retry_after or timedelta(0), exponential)
        state.backoff_until = _utcnow() + delay
        state.last_error = str(exc)[:1000]
        db.commit()
        return state.backoff_until
    finally:
        db.close()


def _record_error(exc: Exception) -> None:
    db = SessionLocal()
    try:
        state = _load_state(db)
        state.last_error = str(exc)[:1000]
        db.commit()
    finally:
        db.close()


def sync_repeaters(trigger: str = "manual") -> dict:
    """Run one sync if the persisted gate allows it.

    `trigger` is "startup", "scheduled" or "manual". Every trigger honors a
    denial block and a 429 backoff; non-manual triggers also honor the
    configured interval since the last attempt.
    """
    if not settings.repeaterbook_enabled:
        return {"status": "disabled"}
    if not _sync_lock.acquire(blocking=False):
        return {"status": "skipped", "reason": "sync already running"}
    try:
        db = None
        try:
            db = SessionLocal()
            state = _load_state(db)
            now = _utcnow()
            reason = _gate_reason(state, now, trigger)
            if reason:
                db.commit()
                if trigger != "scheduled":
                    print(f"[RepeaterBook] {trigger} sync skipped: {reason}")
                return {"status": "skipped", "reason": reason}
            # Record the attempt before any request so a crash or restart
            # mid-fetch still counts toward the interval.
            state.last_attempt_at = now
            db.commit()
        except Exception as exc:
            # Fail closed: if the gate can't be evaluated, don't call out.
            if db is not None:
                db.rollback()
            print(f"[RepeaterBook] Sync state unavailable, not syncing: {exc}")
            return {"status": "skipped", "reason": f"state unavailable: {exc}"}
        finally:
            if db is not None:
                db.close()

        print(f"[RepeaterBook] Syncing repeaters ({trigger})…")
        try:
            rows = fetch_repeaterbook()
        except RepeaterBookDenied as exc:
            _record_denial(exc)
            print(
                f"[RepeaterBook] ACCESS DENIED ({exc}). Batch aborted; all further "
                "syncs are blocked until the cause is corrected and the block is cleared."
            )
            return {"status": "blocked", "reason": str(exc)}
        except RepeaterBookRateLimited as exc:
            until = _record_rate_limit(exc)
            print(f"[RepeaterBook] Rate limited. Batch aborted; backing off until {until} UTC.")
            return {"status": "rate_limited", "backoff_until": until.isoformat()}
        except RepeaterBookError as exc:
            _record_error(exc)
            print(f"[RepeaterBook] {exc}. Batch aborted.")
            return {"status": "error", "reason": str(exc)}

        _upsert(rows)
        return {"status": "ok", "rows": len(rows)}
    finally:
        _sync_lock.release()


def _upsert(rows: list[dict]) -> None:
    db = SessionLocal()
    try:
        state = _load_state(db)
        state.last_success_at = _utcnow()
        state.consecutive_rate_limits = 0
        state.backoff_until = None
        state.last_error = None
        db.commit()
        if not rows:
            print("[RepeaterBook] No results returned.")
            return
        upserted = 0
        outside = 0
        now = _utcnow()
        for row in rows:
            callsign = str(row.get("Callsign", "")).strip().upper()
            freq_hz = _mhz_to_hz(row.get("Frequency", ""))
            if not callsign or not freq_hz:
                continue
            lat = _parse_coord(row.get("Lat"))
            lon = _parse_coord(row.get("Long"))
            if not _within_radius(lat, lon):
                outside += 1
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
            existing.location = str(row.get("Nearest City", "")).strip() or None
            existing.county = str(row.get("County", "")).strip() or None
            existing.state = str(row.get("State", "")).strip() or None
            existing.latitude = lat
            existing.longitude = lon
            existing.use = str(row.get("Use", "")).strip() or None
            existing.digital_modes = _digital_modes(row)
            existing.linked_nodes = _linked_nodes(row)
            existing.last_synced = now
            upserted += 1
        db.commit()
        print(
            f"[RepeaterBook] Upserted {upserted} repeaters "
            f"({outside} outside {settings.repeaterbook_radius_miles} mi)."
        )
        if upserted == 0 and outside == 0:
            # Every row lacked a callsign/frequency: the response schema
            # doesn't match. Log the keys so it can be fixed without refetching.
            print(f"[RepeaterBook] No usable rows; first row keys: {sorted(rows[0].keys())}")
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
    """Background loop. Startup is not a free retry: each tick consults the
    persisted gate (block, backoff, interval since last attempt)."""
    if not settings.repeaterbook_enabled:
        return
    await asyncio.to_thread(sync_repeaters, "startup")
    while True:
        await asyncio.sleep(SCHEDULER_TICK_SEC)
        await asyncio.to_thread(sync_repeaters, "scheduled")
