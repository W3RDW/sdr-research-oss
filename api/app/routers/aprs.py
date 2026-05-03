import json
import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Recording

router = APIRouter()

# Module-level TLE cache (NORAD ID → {data, ts}); populated on first request
_tle_cache: dict = {}
_TLE_TTL = 3600  # seconds

# Uncompressed APRS position: !DDMM.mmN/DDDMM.mmW  (symbol table char between)
# Optional (?:\d{6}[z/h])? handles @DDHHMM[z/h] timestamp prefix in @ packets
_POS_RE = re.compile(
    r"[!=@/\\](?:\d{6}[z/h])?(\d{2})(\d{2}\.\d+)([NS])(.)(\d{3})(\d{2}\.\d+)([EW])"
)
_SPEED_COURSE_RE = re.compile(r"(\d{3})/(\d{3})")
_ALT_RE = re.compile(r"A=(\d{6})")
# APRS weather: cDDD/sSSS format (Peet Bros / some stations)
_WEATHER_RE_C = re.compile(
    r"c(\d{3}|\.\.\.)s(\d{3}|\.\.\.)g(\d{3}|\.\.\.)t(-?\d{3}|\.\.\.)(?:r(\d{3}|\.{3}))?(?:p(\d{3}|\.{3}))?(?:h(\d{2}|\.{2}))?(?:b(\d{5}|\.{5}))?"
)
# APRS weather: DDD/SSSgGGGtTTT format (used after _ symbol — most WX stations)
_WEATHER_RE_DDD = re.compile(
    r"(\d{3})/(\d{3})g(\d{3}|\.\.\.)t(-?\d{3}|\.\.\.)(?:r(\d{3}|\.{3}))?(?:p(\d{3}|\.{3}))?(?:P(\d{3}|\.{3}))?(?:h(\d{2}|\.{2}))?(?:b(\d{5}|\.{5}))?"
)


def _parse_weather(payload: str):
    def _v(s):
        if s is None or "." in s:
            return None
        return int(s)

    m = _WEATHER_RE_C.search(payload)
    if m:
        wd, ws, wg, temp = _v(m.group(1)), _v(m.group(2)), _v(m.group(3)), _v(m.group(4))
        if ws is None and temp is None:
            m = None
        else:
            r1, r24, hum, baro = _v(m.group(5)), _v(m.group(6)), _v(m.group(7)), _v(m.group(8))
            return {
                "wind_dir_deg": wd, "wind_speed_mph": ws, "wind_gust_mph": wg, "temp_f": temp,
                "rain_1h_in": round(r1 * 0.01, 2) if r1 is not None else None,
                "rain_24h_in": round(r24 * 0.01, 2) if r24 is not None else None,
                "humidity_pct": hum,
                "pressure_mbar": round(baro * 0.1, 1) if baro is not None else None,
            }

    m = _WEATHER_RE_DDD.search(payload)
    if not m:
        return None
    wd, ws, wg, temp = _v(m.group(1)), _v(m.group(2)), _v(m.group(3)), _v(m.group(4))
    if ws is None and temp is None:
        return None
    r1, r24, hum, baro = _v(m.group(5)), _v(m.group(6)), _v(m.group(8)), _v(m.group(9))
    return {
        "wind_dir_deg": wd, "wind_speed_mph": ws, "wind_gust_mph": wg, "temp_f": temp,
        "rain_1h_in": round(r1 * 0.01, 2) if r1 is not None else None,
        "rain_24h_in": round(r24 * 0.01, 2) if r24 is not None else None,
        "humidity_pct": hum,
        "pressure_mbar": round(baro * 0.1, 1) if baro is not None else None,
    }


def _parse_position(payload: str):
    m = _POS_RE.search(payload)
    if not m:
        return None
    lat_d, lat_m, lat_h, _, lon_d, lon_m, lon_h = m.groups()
    lat = float(lat_d) + float(lat_m) / 60
    if lat_h == "S":
        lat = -lat
    lon = float(lon_d) + float(lon_m) / 60
    if lon_h == "W":
        lon = -lon
    return round(lat, 6), round(lon, 6)


def _parse_comment(payload: str) -> str:
    s = re.sub(r"^[!=@/\\]\d{4}\.\d+[NS].\d{5}\.\d+[EW].", "", payload)
    s = re.sub(r"^\d{3}/\d{3}", "", s)
    s = re.sub(r"/?A=\d+", "", s)
    return s.strip()


def _parse_packet(line: str):
    if ">" not in line or ":" not in line:
        return None
    try:
        callsign = line.split(">")[0].strip()
        colon_idx = line.index(":")
        header = line[:colon_idx]
        payload = line[colon_idx + 1:]
        path_parts = header.split(",")
        path = ",".join(path_parts[1:]) if len(path_parts) > 1 else ""
        pos = _parse_position(payload)
        sc = _SPEED_COURSE_RE.search(payload[1:20] if len(payload) > 1 else "")
        speed_kt = int(sc.group(2)) if sc else None
        course = int(sc.group(1)) if sc else None
        alt_m = _ALT_RE.search(payload)
        altitude_ft = int(alt_m.group(1)) if alt_m else None
        comment = _parse_comment(payload)
        # Detect WX: data-type '_' (no-position) OR '_' symbol char after position
        is_weather = len(payload) > 0 and payload[0] == "_"
        if not is_weather:
            _pm = _POS_RE.search(payload)
            if _pm and _pm.end() < len(payload) and payload[_pm.end()] == "_":
                is_weather = True
        weather = _parse_weather(payload) if is_weather else None
        return {
            "callsign": callsign,
            "path": path,
            "latitude": pos[0] if pos else None,
            "longitude": pos[1] if pos else None,
            "speed_kt": speed_kt,
            "course": course,
            "altitude_ft": altitude_ft,
            "comment": comment,
            "packet": line.strip(),
            "is_weather": is_weather,
            "weather": weather,
        }
    except Exception:
        return None


@router.get("/stations")
def get_aprs_stations(
    hours: int = Query(24, ge=1, le=168),
    db: Session = Depends(get_db),
):
    since = datetime.utcnow() - timedelta(hours=hours)
    rows = (
        db.query(Recording)
        .filter(
            Recording.mode == "aprs",
            Recording.transcript.isnot(None),
            Recording.timestamp >= since,
        )
        .order_by(desc(Recording.timestamp))
        .limit(2000)
        .all()
    )
    stations: dict = {}
    for rec in rows:
        for line in (rec.transcript or "").splitlines():
            p = _parse_packet(line)
            if not p:
                continue
            cs = p["callsign"]
            if cs not in stations:
                stations[cs] = {
                    **p,
                    "last_heard": rec.timestamp.isoformat() if rec.timestamp else None,
                    "frequency_hz": rec.frequency_hz,
                    "source": rec.source_sdr or "rf",
                }
            elif p["latitude"] is not None and stations[cs]["latitude"] is None:
                stations[cs].update({
                    **p,
                    "last_heard": rec.timestamp.isoformat() if rec.timestamp else None,
                    "source": rec.source_sdr or "rf",
                })
    return {"stations": list(stations.values()), "hours": hours}


@router.get("/tracks")
def get_aprs_tracks(
    hours: int = Query(24, ge=1, le=168),
    db: Session = Depends(get_db),
):
    """Return per-callsign position tracks for drawing on the map."""
    since = datetime.utcnow() - timedelta(hours=hours)
    rows = (
        db.query(Recording)
        .filter(
            Recording.mode == "aprs",
            Recording.transcript.isnot(None),
            Recording.timestamp >= since,
        )
        .order_by(Recording.timestamp)
        .limit(5000)
        .all()
    )
    tracks: dict = {}
    for rec in rows:
        for line in (rec.transcript or "").splitlines():
            p = _parse_packet(line)
            if not p or p["latitude"] is None or p["longitude"] is None:
                continue
            cs = p["callsign"]
            if cs not in tracks:
                tracks[cs] = []
            tracks[cs].append({
                "lat": p["latitude"],
                "lon": p["longitude"],
                "timestamp": rec.timestamp.isoformat() if rec.timestamp else None,
            })
    return {
        "tracks": [
            {"callsign": cs, "positions": positions}
            for cs, positions in tracks.items()
            if len(positions) >= 2
        ],
        "hours": hours,
    }


@router.get("/packets")
def get_aprs_packets(
    callsign: Optional[str] = None,
    hours: int = Query(24, ge=1, le=168),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    since = datetime.utcnow() - timedelta(hours=hours)
    q = db.query(Recording).filter(
        Recording.mode == "aprs",
        Recording.timestamp >= since,
    )
    if callsign:
        q = q.filter(Recording.transcript.ilike(f"%{callsign.upper()}%"))
    total = q.count()
    rows = (
        q.order_by(desc(Recording.timestamp))
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )
    packets = []
    for rec in rows:
        for line in (rec.transcript or "").splitlines():
            p = _parse_packet(line)
            if p:
                packets.append({
                    **p,
                    "id": rec.id,
                    "timestamp": rec.timestamp.isoformat() if rec.timestamp else None,
                    "frequency_hz": rec.frequency_hz,
                    "source": rec.source_sdr or "rf",
                })
    return {"packets": packets, "total": total, "page": page, "limit": limit}


@router.get("/export")
def export_aprs(
    format: str = Query("geojson", regex="^(geojson|csv)$"),
    hours: int = Query(24, ge=1, le=168),
    db: Session = Depends(get_db),
):
    """Export all APRS station positions as GeoJSON or CSV."""
    import csv as _csv
    import io as _io
    from fastapi.responses import StreamingResponse

    since = datetime.utcnow() - timedelta(hours=hours)
    rows = (
        db.query(Recording)
        .filter(
            Recording.mode == "aprs",
            Recording.transcript.isnot(None),
            Recording.timestamp >= since,
        )
        .order_by(desc(Recording.timestamp))
        .limit(5000)
        .all()
    )

    # Collect unique latest position per callsign
    stations: dict = {}
    for rec in rows:
        for line in (rec.transcript or "").splitlines():
            p = _parse_packet(line)
            if not p:
                continue
            cs = p["callsign"]
            if cs not in stations:
                stations[cs] = {
                    **p,
                    "last_heard": rec.timestamp.isoformat() if rec.timestamp else None,
                    "frequency_hz": rec.frequency_hz,
                }

    if format == "geojson":
        features = []
        for cs, s in stations.items():
            if s["latitude"] is None or s["longitude"] is None:
                continue
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [s["longitude"], s["latitude"]]},
                "properties": {
                    "callsign": cs,
                    "last_heard": s.get("last_heard"),
                    "comment": s.get("comment"),
                    "speed_kt": s.get("speed_kt"),
                    "altitude_ft": s.get("altitude_ft"),
                    "frequency_hz": s.get("frequency_hz"),
                },
            })
        geojson = {"type": "FeatureCollection", "features": features}
        import json as _json
        return StreamingResponse(
            _io.BytesIO(_json.dumps(geojson, indent=2).encode()),
            media_type="application/geo+json",
            headers={"Content-Disposition": f'attachment; filename="aprs-{hours}h.geojson"'},
        )

    # CSV
    buf = _io.StringIO()
    writer = _csv.writer(buf)
    writer.writerow(["callsign", "latitude", "longitude", "last_heard", "comment",
                      "speed_kt", "altitude_ft", "frequency_hz"])
    for cs, s in stations.items():
        writer.writerow([
            cs,
            s.get("latitude", ""),
            s.get("longitude", ""),
            s.get("last_heard", ""),
            s.get("comment", ""),
            s.get("speed_kt", ""),
            s.get("altitude_ft", ""),
            s.get("frequency_hz", ""),
        ])
    return StreamingResponse(
        _io.BytesIO(buf.getvalue().encode()),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="aprs-{hours}h.csv"'},
    )


@router.get("/voice-callsigns")
async def voice_callsigns(
    hours: int = Query(72, ge=1, le=720),
    db: Session = Depends(get_db),
):
    """
    Return callsigns heard in voice recordings with their FCC-registered coordinates.
    Used to overlay operator positions on the map alongside APRS stations.
    """
    from ..models import CallsignInfo
    from ..services.tagging import extract_callsign_tags, parse_ai_tags
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    recs = (
        db.query(Recording)
        .filter(
            Recording.mode == "voice",
            Recording.timestamp >= cutoff,
            Recording.transcript.isnot(None),
        )
        .order_by(Recording.timestamp.desc())
        .limit(1000)
        .all()
    )
    # Collect unique callsigns with their lat/lon from callsign_cache
    callsign_latest: dict = {}
    for rec in recs:
        cs_tags = extract_callsign_tags(rec.transcript)
        ai_tags = parse_ai_tags(rec.ai_tags)
        all_cs = list(dict.fromkeys(cs_tags + ai_tags))
        for cs in all_cs:
            if cs not in callsign_latest:
                callsign_latest[cs] = rec.timestamp
    stations = []
    for cs, last_heard in callsign_latest.items():
        info = db.query(CallsignInfo).filter(CallsignInfo.callsign == cs).first()
        if not info or info.latitude is None or info.longitude is None:
            continue
        stations.append({
            "callsign": cs,
            "name": info.name,
            "latitude": info.latitude,
            "longitude": info.longitude,
            "qth_city": info.qth_city,
            "qth_state": info.qth_state,
            "grid": info.grid,
            "last_heard": last_heard.isoformat() if last_heard else None,
        })
    return {"stations": stations, "total": len(stations)}


@router.get("/satellites/tle/{norad_id}")
async def get_satellite_tle(norad_id: int):
    """
    Proxy Celestrak TLE for a given NORAD ID.
    Caches results for 1 hour to avoid hammering Celestrak.
    """
    import time as _time
    import urllib.request as _ureq
    import urllib.error as _uerr

    cached = _tle_cache.get(norad_id)
    if cached and _time.time() - cached["ts"] < _TLE_TTL:
        return cached["data"]

    url = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={norad_id}&FORMAT=TLE"
    try:
        with _ureq.urlopen(url, timeout=10) as resp:
            text = resp.read().decode("utf-8")
    except _uerr.URLError as exc:
        raise HTTPException(status_code=503, detail=f"Celestrak unreachable: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"TLE fetch error: {exc}")

    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if len(lines) < 3 or not lines[1].startswith("1 ") or not lines[2].startswith("2 "):
        raise HTTPException(status_code=502, detail=f"Invalid TLE response from Celestrak (got: {text[:120]!r})")
    data = {"name": lines[0], "line1": lines[1], "line2": lines[2]}
    _tle_cache[norad_id] = {"data": data, "ts": _time.time()}
    return data


@router.get("/aircraft")
async def get_aircraft(
    min_altitude: Optional[int] = None,
    max_altitude: Optional[int] = None,
    max_seen_sec: Optional[int] = None,
):
    """
    Proxy current aircraft positions from the ADS-B ultrafeeder deployment.
    Returns readsb aircraft.json enriched with optional altitude/staleness filters.
    Source: http://ultrafeeder.adsb.svc.cluster.local/data/aircraft.json
    """
    import urllib.request as _ureq
    import urllib.error as _uerr
    ULTRAFEEDER_URL = "http://ultrafeeder.adsb.svc.cluster.local/data/aircraft.json"
    try:
        with _ureq.urlopen(ULTRAFEEDER_URL, timeout=8) as resp:
            data = json.loads(resp.read())
    except _uerr.URLError as exc:
        raise HTTPException(status_code=503, detail=f"ultrafeeder unreachable: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"aircraft data error: {exc}")

    aircraft = data.get("aircraft", [])
    total_raw = len(aircraft)

    # Filter out stale aircraft (not heard recently)
    if max_seen_sec is not None:
        aircraft = [a for a in aircraft if isinstance(a.get("seen"), (int, float)) and a["seen"] <= max_seen_sec]

    # Apply optional altitude filters; alt_baro can be the string "ground" — skip those rows
    if min_altitude is not None:
        aircraft = [a for a in aircraft if isinstance(a.get("alt_baro"), (int, float)) and a["alt_baro"] >= min_altitude]
    if max_altitude is not None:
        aircraft = [a for a in aircraft if isinstance(a.get("alt_baro"), (int, float)) and a["alt_baro"] <= max_altitude]

    return {
        "now": data.get("now"),
        "messages": data.get("messages"),
        "total": len(aircraft),
        "total_raw": total_raw,
        "aircraft": aircraft,
    }


@router.get("/ais/vessels")
async def get_ais_vessels():
    """Proxy live vessel list from ais-catcher HTTP server."""
    import urllib.request as _ureq
    import urllib.error as _uerr
    AIS_URL = "http://ais-catcher.sdr-research.svc.cluster.local:8100/vessels"
    try:
        with _ureq.urlopen(AIS_URL, timeout=5) as resp:
            data = json.loads(resp.read())
    except _uerr.URLError as exc:
        print(f"[AIS] ais-catcher unreachable: {exc}")
        return {"vessels": [], "available": False}
    except Exception as exc:
        print(f"[AIS] AIS data error: {exc}")
        return {"vessels": [], "available": False}
    if isinstance(data, list):
        return {"vessels": data, "available": True}
    if isinstance(data, dict):
        payload = dict(data)
        vessels = payload.get("vessels")
        if isinstance(vessels, list):
            payload.setdefault("available", True)
            return payload
    return {"vessels": [], "available": True}
