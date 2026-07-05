"""Ham satellite TLEs, server-side pass prediction, and recording windows.

The UI predicts passes client-side with satellite.js; this module adds a
server-side predictor (sgp4) so the indexer can write upcoming downlink
windows to /data/detections/sat_windows.json — unified-sdr reads that file
and arms a recorder slot on the downlink frequency during each pass.
"""

import json
import math
import os
import time as _time
import urllib.request
from datetime import datetime, timedelta, timezone

from ..config import settings

HAM_SATELLITES = [
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


def station_coords() -> tuple[float, float]:
    lat = settings.station_lat or settings.repeaterbook_latitude
    lon = settings.station_lon or settings.repeaterbook_longitude
    return float(lat or 0.0), float(lon or 0.0)


def fetch_satellite_tles() -> list[dict]:
    """Fetch TLEs for the ham satellite set from Celestrak, cached 6 h."""
    now = _time.monotonic()
    if (
        _tle_cache.get("ts") is not None
        and now - _tle_cache["ts"] < _TLE_CACHE_TTL
        and _tle_cache.get("data")
    ):
        return _tle_cache["data"]

    results = []
    for sat_info in HAM_SATELLITES:
        norad_id = sat_info["norad_id"]
        try:
            url = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={norad_id}&FORMAT=TLE"
            req = urllib.request.Request(url, headers={"User-Agent": "SDRViewer/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode().strip()
            lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
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


# ── Server-side pass prediction ─────────────────────────────────────────────
# TEME→topocentric with a GMST rotation: standard approximation, plenty for
# deciding when to open a recorder window.

_WGS84_A = 6378.137          # km
_WGS84_F = 1 / 298.257223563


def _gmst_rad(dt: datetime) -> float:
    jd = dt.timestamp() / 86400.0 + 2440587.5
    t = (jd - 2451545.0) / 36525.0
    gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) \
        + 0.000387933 * t * t - t * t * t / 38710000.0
    return math.radians(gmst % 360.0)


def _observer_ecef(lat_deg: float, lon_deg: float, alt_km: float = 0.0):
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    e2 = _WGS84_F * (2 - _WGS84_F)
    n = _WGS84_A / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    x = (n + alt_km) * math.cos(lat) * math.cos(lon)
    y = (n + alt_km) * math.cos(lat) * math.sin(lon)
    z = (n * (1 - e2) + alt_km) * math.sin(lat)
    return x, y, z


def _elevation_deg(sat_teme, dt: datetime, lat_deg: float, lon_deg: float) -> float:
    theta = _gmst_rad(dt)
    ct, st = math.cos(theta), math.sin(theta)
    # TEME → pseudo-ECEF
    sx = ct * sat_teme[0] + st * sat_teme[1]
    sy = -st * sat_teme[0] + ct * sat_teme[1]
    sz = sat_teme[2]
    ox, oy, oz = _observer_ecef(lat_deg, lon_deg)
    rx, ry, rz = sx - ox, sy - oy, sz - oz
    rng = math.sqrt(rx * rx + ry * ry + rz * rz)
    # Elevation = angle between range vector and local horizontal (up = ECEF
    # position direction for a spherical-ish approximation).
    om = math.sqrt(ox * ox + oy * oy + oz * oz)
    cos_zenith = (rx * ox + ry * oy + rz * oz) / (rng * om)
    return math.degrees(math.asin(max(-1.0, min(1.0, cos_zenith))))


def compute_passes(hours: int = 12, min_elevation: float = 10.0,
                   step_seconds: int = 30) -> list[dict]:
    """Predict passes over the station for the cached TLE set."""
    try:
        from sgp4.api import Satrec, jday
    except ImportError:
        return []

    lat, lon = station_coords()
    if not lat and not lon:
        return []

    passes = []
    start = datetime.now(timezone.utc)
    steps = int(hours * 3600 / step_seconds)
    for sat in fetch_satellite_tles():
        try:
            rec = Satrec.twoline2rv(sat["tle_line1"], sat["tle_line2"])
        except Exception:
            continue
        in_pass = False
        p = None
        for i in range(steps):
            dt = start + timedelta(seconds=i * step_seconds)
            jd, fr = jday(dt.year, dt.month, dt.day, dt.hour, dt.minute,
                          dt.second + dt.microsecond / 1e6)
            err, pos, _vel = rec.sgp4(jd, fr)
            if err != 0:
                break
            el = _elevation_deg(pos, dt, lat, lon)
            if el >= min_elevation and not in_pass:
                in_pass = True
                p = {"satellite": sat["name"], "norad_id": sat["norad_id"],
                     "start": dt, "max_elevation": el,
                     "frequencies": sat["frequencies"]}
            elif in_pass:
                if el > p["max_elevation"]:
                    p["max_elevation"] = el
                if el < min_elevation:
                    p["end"] = dt
                    passes.append(p)
                    in_pass = False
                    p = None
        if in_pass and p is not None:
            p["end"] = start + timedelta(seconds=steps * step_seconds)
            passes.append(p)

    passes.sort(key=lambda x: x["start"])
    return passes


def sync_sat_windows(detections_dir: str) -> int:
    """Write upcoming downlink recording windows for unified-sdr.

    Returns the number of windows written. Windows get a small lead/lag pad
    so the recorder is armed before AOS.
    """
    if not settings.sat_windows_enabled:
        return 0
    windows = []
    for p in compute_passes(hours=12,
                            min_elevation=settings.sat_record_min_elevation):
        for f in p["frequencies"]:
            if f.get("direction") != "downlink":
                continue
            windows.append({
                "satellite": p["satellite"],
                "freq_hz": int(round(f["mhz"] * 1e6)),
                "mode": f["mode"],
                "start_epoch": int(p["start"].timestamp()) - 30,
                "end_epoch": int(p["end"].timestamp()) + 30,
                "max_elevation": round(p["max_elevation"], 1),
            })
    lat, lon = station_coords()
    out = {
        "updated_epoch": int(_time.time()),
        "station": {"latitude": lat, "longitude": lon},
        "min_elevation": settings.sat_record_min_elevation,
        "windows": windows,
    }
    path = os.path.join(detections_dir, "sat_windows.json")
    tmp = path + ".tmp"
    try:
        os.makedirs(detections_dir, exist_ok=True)
        with open(tmp, "w") as fh:
            json.dump(out, fh, indent=2)
        os.replace(tmp, path)
    except OSError:
        return 0
    return len(windows)
