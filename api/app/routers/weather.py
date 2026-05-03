"""Weather intelligence proxy: NWS alerts, METAR observations, NWS forecast,
SPC convective outlook, SPC storm reports, SPC mesoscale discussions.

Mounted as sub-router of stats (main.py is baked into the image and cannot
add new top-level routers). Endpoints live under /api/v1/stats/weather/*.
"""
import asyncio
import csv
import io
import json
import re
import time as _time
from datetime import datetime, timedelta
from math import asin, cos, radians, sin, sqrt
from typing import Any, Optional
from urllib import error as _uerr
from urllib import request as _ureq

from fastapi import APIRouter, HTTPException, Query

from ..config import settings

router = APIRouter(prefix="/weather", tags=["weather"])

USER_AGENT = (
    "sdr-research/1.0 (whitehouse-rke2; "
    "https://github.com/w3rdw/sdr-research-oss; operator@example.com)"
)

# ── tiny TTL cache ──────────────────────────────────────────────────
_cache: dict[str, tuple[float, Any]] = {}

def _cache_get(key: str, ttl: float):
    entry = _cache.get(key)
    if entry is None:
        return None
    ts, value = entry
    if _time.time() - ts > ttl:
        return None
    return value

def _cache_set(key: str, value: Any):
    _cache[key] = (_time.time(), value)

def _http_get(url: str, accept: str, timeout: int) -> bytes:
    req = _ureq.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": accept,
    })
    with _ureq.urlopen(req, timeout=timeout) as resp:
        return resp.read()

async def _fetch_json(url: str, timeout: int = 15) -> Any:
    raw = await asyncio.to_thread(
        _http_get, url, "application/geo+json, application/json", timeout
    )
    return json.loads(raw.decode("utf-8", errors="replace"))

async def _fetch_text(url: str, timeout: int = 15) -> str:
    raw = await asyncio.to_thread(
        _http_get, url, "text/plain, text/csv, application/xml, */*", timeout
    )
    return raw.decode("utf-8", errors="replace")

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0088
    p1, p2 = radians(lat1), radians(lat2)
    dp = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    a = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * R * asin(sqrt(a))

def _resolve_lat_lon(
    lat: Optional[float], lon: Optional[float]
) -> tuple[float, float]:
    if lat is None:
        lat = float(settings.repeaterbook_latitude)
    if lon is None:
        lon = float(settings.repeaterbook_longitude)
    return lat, lon

def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"

# ── NWS active alerts ──────────────────────────────────────────────
@router.get("/alerts")
async def get_alerts(
    lat: Optional[float] = Query(None),
    lon: Optional[float] = Query(None),
):
    """Active NWS watches/warnings/advisories at a point.

    Default location uses the station coordinates. Returns full GeoJSON-style
    polygons so the UI can draw them on the map.
    """
    lat, lon = _resolve_lat_lon(lat, lon)
    cache_key = f"alerts:{lat:.3f}:{lon:.3f}"
    cached = _cache_get(cache_key, ttl=60)
    if cached is not None:
        return cached

    url = f"https://api.weather.gov/alerts/active?point={lat:.4f},{lon:.4f}"
    try:
        data = await _fetch_json(url, timeout=12)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"NWS alerts unavailable: {exc}"
        )

    alerts = []
    for feat in data.get("features", []) or []:
        props = feat.get("properties", {}) or {}
        alerts.append({
            "id": props.get("id") or feat.get("id"),
            "event": props.get("event"),
            "severity": props.get("severity"),
            "urgency": props.get("urgency"),
            "certainty": props.get("certainty"),
            "status": props.get("status"),
            "messageType": props.get("messageType"),
            "category": props.get("category"),
            "headline": props.get("headline"),
            "description": props.get("description"),
            "instruction": props.get("instruction"),
            "areaDesc": props.get("areaDesc"),
            "sent": props.get("sent"),
            "effective": props.get("effective"),
            "onset": props.get("onset"),
            "expires": props.get("expires"),
            "ends": props.get("ends"),
            "senderName": props.get("senderName"),
            "geometry": feat.get("geometry"),
        })

    # Sort by severity then expiration
    sev_rank = {
        "Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3, "Unknown": 4
    }
    alerts.sort(key=lambda a: (
        sev_rank.get(a.get("severity") or "Unknown", 4),
        a.get("expires") or "",
    ))

    result = {
        "alerts": alerts,
        "count": len(alerts),
        "lat": lat,
        "lon": lon,
        "fetched_at": _now_iso(),
    }
    _cache_set(cache_key, result)
    return result

# ── NWS METAR / surface observations ──────────────────────────────
async def _nws_get_stations(lat: float, lon: float):
    cache_key = f"stations:{lat:.2f}:{lon:.2f}"
    cached = _cache_get(cache_key, ttl=86400)
    if cached is not None:
        return cached
    point = await _fetch_json(
        f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}", timeout=10
    )
    stations_url = (point.get("properties") or {}).get("observationStations")
    if not stations_url:
        return []
    data = await _fetch_json(stations_url, timeout=15)
    stations: list[dict] = []
    for feat in data.get("features", []) or []:
        props = feat.get("properties", {}) or {}
        coords = ((feat.get("geometry") or {}).get("coordinates")) or [None, None]
        s_lon, s_lat = coords[0], coords[1]
        if s_lat is None or s_lon is None:
            continue
        stations.append({
            "id": props.get("stationIdentifier"),
            "name": props.get("name"),
            "lat": s_lat,
            "lon": s_lon,
            "url": feat.get("id"),
        })
    _cache_set(cache_key, stations)
    return stations

@router.get("/metars")
async def get_metars(
    lat: Optional[float] = Query(None),
    lon: Optional[float] = Query(None),
    radius_km: float = Query(150, ge=10, le=500),
    limit: int = Query(8, ge=1, le=30),
):
    """Latest METAR observations from NWS stations near a point."""
    lat, lon = _resolve_lat_lon(lat, lon)
    cache_key = f"metars:{lat:.3f}:{lon:.3f}:{int(radius_km)}:{limit}"
    cached = _cache_get(cache_key, ttl=300)
    if cached is not None:
        return cached

    try:
        stations = await _nws_get_stations(lat, lon)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"NWS stations unavailable: {exc}"
        )

    nearby: list[tuple[float, dict]] = []
    for s in stations:
        d = _haversine_km(lat, lon, s["lat"], s["lon"])
        if d <= radius_km:
            nearby.append((d, s))
    nearby.sort(key=lambda x: x[0])
    nearby = nearby[:limit]

    async def _fetch_obs(station):
        try:
            data = await _fetch_json(
                f"{station['url']}/observations/latest", timeout=10
            )
            return data.get("properties") or {}
        except Exception:
            return None

    results = await asyncio.gather(*[_fetch_obs(s) for _, s in nearby])

    metars: list[dict] = []
    for (dist_km, s), props in zip(nearby, results):
        if not props:
            continue
        tc = (props.get("temperature") or {}).get("value")
        dc = (props.get("dewpoint") or {}).get("value")
        wd = (props.get("windDirection") or {}).get("value")
        wsm = (props.get("windSpeed") or {}).get("value")
        wgm = (props.get("windGust") or {}).get("value")
        vm = (props.get("visibility") or {}).get("value")
        pp = (props.get("seaLevelPressure") or {}).get("value")
        rh = (props.get("relativeHumidity") or {}).get("value")
        ceiling_m = None
        for layer in props.get("cloudLayers") or []:
            if (layer or {}).get("amount") in ("BKN", "OVC", "VV"):
                ceiling_m = ((layer or {}).get("base") or {}).get("value")
                break
        metars.append({
            "station_id": s["id"],
            "name": s["name"],
            "lat": s["lat"],
            "lon": s["lon"],
            "distance_km": round(dist_km, 1),
            "timestamp": props.get("timestamp"),
            "temp_c": round(tc, 1) if tc is not None else None,
            "temp_f": round(tc * 9 / 5 + 32, 1) if tc is not None else None,
            "dewpoint_c": round(dc, 1) if dc is not None else None,
            "dewpoint_f": round(dc * 9 / 5 + 32, 1) if dc is not None else None,
            "humidity_pct": round(rh) if rh is not None else None,
            "wind_dir_deg": int(wd) if wd is not None else None,
            "wind_speed_kt": round(wsm * 1.94384) if wsm is not None else None,
            "wind_gust_kt": round(wgm * 1.94384) if wgm is not None else None,
            "wind_speed_mph": round(wsm * 2.23694) if wsm is not None else None,
            "wind_gust_mph": round(wgm * 2.23694) if wgm is not None else None,
            "visibility_mi": round(vm * 0.000621371, 1) if vm is not None else None,
            "ceiling_ft": round(ceiling_m * 3.28084) if ceiling_m is not None else None,
            "pressure_mbar": round(pp / 100, 1) if pp is not None else None,
            "raw_metar": props.get("rawMessage"),
            "text_description": props.get("textDescription"),
            "icon": props.get("icon"),
        })

    result = {
        "metars": metars,
        "count": len(metars),
        "lat": lat,
        "lon": lon,
        "fetched_at": _now_iso(),
    }
    _cache_set(cache_key, result)
    return result

# ── NWS gridded forecast (7-day or hourly) ────────────────────────
@router.get("/forecast")
async def get_forecast(
    lat: Optional[float] = Query(None),
    lon: Optional[float] = Query(None),
    hourly: bool = Query(False),
):
    """NWS gridded forecast — 7-day periods or 156-hour hourly."""
    lat, lon = _resolve_lat_lon(lat, lon)
    cache_key = f"forecast:{lat:.3f}:{lon:.3f}:{int(hourly)}"
    cached = _cache_get(cache_key, ttl=1800)
    if cached is not None:
        return cached

    try:
        point = await _fetch_json(
            f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}", timeout=10
        )
        props = point.get("properties") or {}
        url = props.get("forecastHourly") if hourly else props.get("forecast")
        if not url:
            raise HTTPException(
                status_code=502, detail="NWS gridpoint has no forecast url"
            )
        forecast = await _fetch_json(url, timeout=15)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"NWS forecast unavailable: {exc}"
        )

    fprops = forecast.get("properties") or {}
    periods = []
    for p in fprops.get("periods", []) or []:
        periods.append({
            "name": p.get("name"),
            "start": p.get("startTime"),
            "end": p.get("endTime"),
            "is_daytime": p.get("isDaytime"),
            "temp": p.get("temperature"),
            "temp_unit": p.get("temperatureUnit"),
            "wind_speed": p.get("windSpeed"),
            "wind_dir": p.get("windDirection"),
            "icon": p.get("icon"),
            "short_forecast": p.get("shortForecast"),
            "detailed_forecast": p.get("detailedForecast"),
            "precip_chance": (
                (p.get("probabilityOfPrecipitation") or {}).get("value")
            ),
            "humidity": ((p.get("relativeHumidity") or {}).get("value")),
            "dewpoint_c": ((p.get("dewpoint") or {}).get("value")),
        })

    result = {
        "lat": lat,
        "lon": lon,
        "office": props.get("gridId"),
        "grid_x": props.get("gridX"),
        "grid_y": props.get("gridY"),
        "city": ((props.get("relativeLocation") or {}).get("properties") or {}).get("city"),
        "state": ((props.get("relativeLocation") or {}).get("properties") or {}).get("state"),
        "updated": fprops.get("updated"),
        "hourly": hourly,
        "periods": periods,
        "fetched_at": _now_iso(),
    }
    _cache_set(cache_key, result)
    return result

# ── SPC convective outlook (Day 1/2/3) ────────────────────────────
SPC_LAYERS_BY_DAY = {
    1: ["cat", "torn", "hail", "wind"],
    2: ["cat", "torn", "hail", "wind"],
    3: ["cat", "prob"],
}

@router.get("/spc-outlook")
async def get_spc_outlook(
    day: int = Query(1, ge=1, le=3),
    layer: str = Query("cat"),
):
    """SPC convective outlook GeoJSON polygons."""
    valid = SPC_LAYERS_BY_DAY.get(day, [])
    if layer not in valid:
        raise HTTPException(
            status_code=400,
            detail=f"layer must be one of {valid} for day {day}",
        )

    cache_key = f"spc:{day}:{layer}"
    cached = _cache_get(cache_key, ttl=900)
    if cached is not None:
        return cached

    url = f"https://www.spc.noaa.gov/products/outlook/day{day}otlk_{layer}.lyr.geojson"
    try:
        data = await _fetch_json(url, timeout=12)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"SPC outlook unavailable: {exc}"
        )

    result = {
        "day": day,
        "layer": layer,
        "geojson": data,
        "fetched_at": _now_iso(),
    }
    _cache_set(cache_key, result)
    return result

# ── SPC storm reports (today / yesterday / yymmdd) ────────────────
@router.get("/storm-reports")
async def get_storm_reports(
    date: str = Query(
        "today", pattern=r"^(today|yesterday|\d{6})$"
    ),
):
    """SPC local storm reports — tornado / hail / wind."""
    if date == "today":
        url_path = "today_filtered.csv"
        date_label = datetime.utcnow().strftime("%Y-%m-%d")
    elif date == "yesterday":
        url_path = "yesterday_filtered.csv"
        date_label = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
    else:
        url_path = f"{date}_rpts_filtered.csv"
        date_label = f"20{date[:2]}-{date[2:4]}-{date[4:6]}"

    cache_key = f"reports:{date}"
    cached = _cache_get(cache_key, ttl=300)
    if cached is not None:
        return cached

    url = f"https://www.spc.noaa.gov/climo/reports/{url_path}"
    try:
        text_data = await _fetch_text(url, timeout=12)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"SPC reports unavailable: {exc}"
        )

    reports: list[dict] = []
    current_type: Optional[str] = None
    headers: list[str] = []
    reader = csv.reader(io.StringIO(text_data))
    for row in reader:
        if not row:
            continue
        first = (row[0] or "").strip().lower()
        if first == "time":
            headers = [c.strip().lower() for c in row]
            if "f_scale" in headers:
                current_type = "tornado"
            elif "size" in headers:
                current_type = "hail"
            elif "speed" in headers:
                current_type = "wind"
            else:
                current_type = "other"
            continue
        if not headers or len(row) < len(headers):
            continue
        rec = dict(zip(headers, [c.strip() for c in row]))
        try:
            lat_v = float(rec.get("lat", "") or 0)
            lon_v = float(rec.get("lon", "") or 0)
        except ValueError:
            continue
        if not lat_v or not lon_v:
            continue
        reports.append({
            "type": current_type,
            "time": rec.get("time"),
            "magnitude": (
                rec.get("f_scale") or rec.get("size") or rec.get("speed")
            ),
            "location": rec.get("location"),
            "county": rec.get("county"),
            "state": rec.get("state"),
            "lat": lat_v,
            "lon": lon_v,
            "comments": rec.get("comments", ""),
        })

    result = {
        "date": date_label,
        "reports": reports,
        "by_type": {
            t: sum(1 for r in reports if r["type"] == t)
            for t in ("tornado", "hail", "wind")
        },
        "count": len(reports),
        "fetched_at": _now_iso(),
    }
    _cache_set(cache_key, result)
    return result

# ── SPC mesoscale discussions ─────────────────────────────────────
@router.get("/mesoscale-discussions")
async def get_mesoscale_discussions():
    """Active SPC Mesoscale Discussions (RSS feed)."""
    cache_key = "md:active"
    cached = _cache_get(cache_key, ttl=300)
    if cached is not None:
        return cached

    url = "https://www.spc.noaa.gov/products/spcmdrss.xml"
    try:
        text_data = await _fetch_text(url, timeout=12)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"SPC MD unavailable: {exc}"
        )

    items: list[dict] = []
    for m in re.finditer(r"<item>(.*?)</item>", text_data, re.DOTALL):
        block = m.group(1)
        def _x(tag: str) -> Optional[str]:
            mm = re.search(rf"<{tag}>(.*?)</{tag}>", block, re.DOTALL)
            return mm.group(1).strip() if mm else None
        items.append({
            "title": _x("title"),
            "link": _x("link"),
            "pub_date": _x("pubDate"),
            "description": _x("description"),
        })

    result = {
        "items": items,
        "count": len(items),
        "fetched_at": _now_iso(),
    }
    _cache_set(cache_key, result)
    return result

# ── Aggregated summary (single fetch for the dashboard) ───────────
@router.get("/summary")
async def get_summary(
    lat: Optional[float] = Query(None),
    lon: Optional[float] = Query(None),
):
    """One-shot dashboard payload — alerts + metars + forecast + outlook + reports + MDs."""
    lat, lon = _resolve_lat_lon(lat, lon)
    results = await asyncio.gather(
        get_alerts(lat=lat, lon=lon),
        get_metars(lat=lat, lon=lon),
        get_forecast(lat=lat, lon=lon, hourly=False),
        get_spc_outlook(day=1, layer="cat"),
        get_storm_reports(date="today"),
        get_mesoscale_discussions(),
        return_exceptions=True,
    )
    keys = ("alerts", "metars", "forecast", "spc_outlook", "storm_reports", "mesoscale_discussions")
    payload: dict[str, Any] = {"lat": lat, "lon": lon, "fetched_at": _now_iso()}
    for k, v in zip(keys, results):
        payload[k] = None if isinstance(v, Exception) else v
    return payload
