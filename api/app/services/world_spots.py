"""PSKReporter comparison — "my antenna vs the world".

For callsigns this station has recently decoded (FT8/WSPR spots table), ask
PSKReporter who else heard the same sender in the same window and at what
SNR. That yields a per-sample rank: if the world's median monitor hears a
station at -5 dB and we log -19 dB, the antenna/receiver chain is
underperforming; if we rank near the top, it is healthy.

PSKReporter etiquette: their retrieval API asks for sparse polling, so we
issue at most ONE query per PSKREPORTER_POLL_SECONDS (default 600), rotating
through recently-decoded callsigns, and keep a rolling window of samples.
"""

import statistics
import threading
import time as _time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import deque

from sqlalchemy import text

from ..config import settings

_QUERY_URL = "https://retrieve.pskreporter.info/query"

_lock = threading.Lock()
_last_fetch = 0.0
_rotation: deque = deque()          # callsigns pending sampling
_samples: deque = deque(maxlen=48)  # rolling sample results (~8h at 10 min)


_BANDS = [
    ("160m", 1_800_000, 2_000_000), ("80m", 3_500_000, 4_000_000),
    ("40m", 7_000_000, 7_300_000), ("30m", 10_100_000, 10_150_000),
    ("20m", 14_000_000, 14_350_000), ("17m", 18_068_000, 18_168_000),
    ("15m", 21_000_000, 21_450_000), ("12m", 24_890_000, 24_990_000),
    ("10m", 28_000_000, 29_700_000), ("6m", 50_000_000, 54_000_000),
    ("2m", 144_000_000, 148_000_000),
]


def _band_for(freq_hz: float | None) -> str | None:
    if not freq_hz:
        return None
    for name, lo, hi in _BANDS:
        if lo <= freq_hz <= hi:
            return name
    return None


def _fetch_world_reports(callsign: str) -> list[dict]:
    """One PSKReporter query: who heard `callsign` in the last 15 minutes."""
    params = urllib.parse.urlencode({
        "senderCallsign": callsign,
        "flowStartSeconds": "-900",
        "rronly": "1",
        "appcontact": "sdr-research-oss",
    })
    req = urllib.request.Request(
        f"{_QUERY_URL}?{params}",
        headers={"User-Agent": "sdr-research-oss/0.3 (+https://github.com/W3RDW/sdr-research-oss)"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        root = ET.fromstring(resp.read())
    reports = []
    for el in root.iter():
        if not el.tag.endswith("receptionReport"):
            continue
        try:
            reports.append({
                "receiver": el.get("receiverCallsign"),
                "receiver_locator": el.get("receiverLocator"),
                "snr": float(el.get("sNR")) if el.get("sNR") is not None else None,
                "freq": float(el.get("frequency")) if el.get("frequency") else None,
                "mode": el.get("mode"),
            })
        except (TypeError, ValueError):
            continue
    return reports


def _my_recent_decodes(db) -> list[dict]:
    rows = db.execute(text(
        """
        SELECT callsign, band, max(snr_db) AS my_snr, count(*) AS n
        FROM spots
        WHERE "timestamp" > now() - interval '20 minutes'
          AND callsign IS NOT NULL
        GROUP BY callsign, band
        ORDER BY n DESC
        LIMIT 25
        """
    )).fetchall()
    return [{"callsign": r.callsign, "band": r.band, "my_snr": r.my_snr}
            for r in rows]


def _sample_one(db) -> dict | None:
    """Rotate to the next recently-decoded callsign and sample the world."""
    global _last_fetch
    decoded = _my_recent_decodes(db)
    if not decoded:
        return None
    by_call = {d["callsign"]: d for d in decoded}
    # Refill rotation with calls we haven't sampled recently
    if not _rotation:
        _rotation.extend(by_call.keys())
    call = None
    while _rotation:
        c = _rotation.popleft()
        if c in by_call:
            call = c
            break
    if call is None:
        call = decoded[0]["callsign"]

    mine = by_call[call]
    world = _fetch_world_reports(call)
    _last_fetch = _time.monotonic()
    # Restrict to the band we heard them on
    band_reports = [w for w in world
                    if w["snr"] is not None and _band_for(w["freq"]) == mine["band"]]
    if not band_reports:
        return {"callsign": call, "band": mine["band"], "my_snr": mine["my_snr"],
                "world_receivers": 0, "sampled_at": _time.time()}
    snrs = sorted(w["snr"] for w in band_reports)
    my_snr = mine["my_snr"]
    rank = sum(1 for s in snrs if s <= my_snr) / len(snrs) if my_snr is not None else None
    return {
        "callsign": call,
        "band": mine["band"],
        "my_snr": my_snr,
        "world_receivers": len(band_reports),
        "world_best_snr": snrs[-1],
        "world_median_snr": statistics.median(snrs),
        "my_rank_pct": round(rank * 100) if rank is not None else None,
        "sampled_at": _time.time(),
    }


def get_comparison(db) -> dict:
    """Rolling antenna-vs-world summary; samples at most once per poll window."""
    if not settings.pskreporter_enabled:
        return {"enabled": False, "samples": [], "health_score": None}

    with _lock:
        if _time.monotonic() - _last_fetch >= settings.pskreporter_poll_seconds:
            try:
                s = _sample_one(db)
                if s:
                    _samples.append(s)
            except Exception as e:
                print(f"[WorldSpots] sample failed: {e}")

    samples = [s for s in _samples
               if _time.time() - s["sampled_at"] < 8 * 3600]
    ranked = [s["my_rank_pct"] for s in samples
              if s.get("my_rank_pct") is not None and s.get("world_receivers", 0) >= 5]
    health = round(statistics.median(ranked)) if ranked else None
    return {
        "enabled": True,
        "poll_seconds": settings.pskreporter_poll_seconds,
        "samples": list(reversed(samples)),
        "health_score": health,  # median percentile rank vs world monitors
    }
