"""On-air activity feeds: POTA + SOTA spots and the WA7BNM contest calendar.

Public, keyless APIs; everything cached so the upstreams see at most one
request per TTL regardless of UI polling.
"""

import json
import threading
import time as _time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

_POTA_URL = "https://api.pota.app/spot/activator"
_SOTA_URL = "https://api2.sota.org.uk/api/spots/40/all"
_CONTEST_RSS = "https://www.contestcalendar.com/calendar.rss"

_cache: dict = {}
_lock = threading.Lock()
_TTL = {"pota": 300, "sota": 300, "contests": 21600}


def _fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "sdr-research-oss/0.3"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _get(kind: str, fetcher):
    now = _time.monotonic()
    ent = _cache.get(kind)
    if ent and now - ent["ts"] < _TTL[kind]:
        return ent["data"]
    with _lock:
        ent = _cache.get(kind)
        if ent and now - ent["ts"] < _TTL[kind]:
            return ent["data"]
        try:
            data = fetcher()
            _cache[kind] = {"ts": now, "data": data}
            return data
        except Exception as e:
            print(f"[ActivityFeeds] {kind} fetch failed: {e}")
            return ent["data"] if ent else []


def _pota_spots() -> list[dict]:
    rows = _fetch_json(_POTA_URL)
    out = []
    for r in rows[:100]:
        try:
            out.append({
                "callsign": r.get("activator"),
                "reference": r.get("reference"),
                "name": r.get("name"),
                "frequency_khz": float(r["frequency"]) if r.get("frequency") else None,
                "mode": r.get("mode"),
                "location": r.get("locationDesc"),
                "spotted_at": r.get("spotTime"),
                "comments": r.get("comments"),
            })
        except (TypeError, ValueError):
            continue
    return out


def _sota_spots() -> list[dict]:
    rows = _fetch_json(_SOTA_URL)
    out = []
    for r in rows[:100]:
        try:
            khz = float(r["frequency"]) * 1000 if r.get("frequency") else None
        except (TypeError, ValueError):
            khz = None
        out.append({
            "callsign": r.get("activatorCallsign"),
            "reference": r.get("summitCode") or r.get("associationCode"),
            "name": r.get("summitName") or r.get("summitDetails"),
            "frequency_khz": khz,
            "mode": r.get("mode"),
            "spotted_at": r.get("timeStamp"),
            "comments": r.get("comments"),
        })
    return out


def _contests() -> list[dict]:
    req = urllib.request.Request(
        _CONTEST_RSS, headers={"User-Agent": "sdr-research-oss/0.3"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        root = ET.fromstring(resp.read())
    out = []
    for item in root.iter("item"):
        title = item.findtext("title") or ""
        desc = (item.findtext("description") or "").strip()
        link = item.findtext("link")
        if title:
            out.append({"title": title.strip(), "dates": desc, "url": link})
    return out[:40]


def get_activity_feeds() -> dict:
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "pota": _get("pota", _pota_spots),
        "sota": _get("sota", _sota_spots),
        "contests": _get("contests", _contests),
    }
