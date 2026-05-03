"""FT8/WSPR/FT4 spot browser and statistics."""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import get_db

router = APIRouter(prefix="/spots", tags=["spots"])

# ── helpers ──────────────────────────────────────────────────────────
_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS spots (
    id SERIAL PRIMARY KEY,
    "timestamp" TIMESTAMP NOT NULL,
    mode VARCHAR(10) NOT NULL,
    dial_frequency_hz BIGINT NOT NULL,
    audio_offset_hz INTEGER,
    snr_db REAL,
    dt REAL,
    callsign VARCHAR(20),
    grid VARCHAR(10),
    power_dbm INTEGER,
    message VARCHAR(255),
    band VARCHAR(10),
    distance_km REAL,
    tx_latitude REAL,
    tx_longitude REAL,
    created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_spots_timestamp ON spots ("timestamp");
CREATE INDEX IF NOT EXISTS ix_spots_mode ON spots (mode);
CREATE INDEX IF NOT EXISTS ix_spots_callsign ON spots (callsign);
CREATE INDEX IF NOT EXISTS ix_spots_dial_frequency_hz ON spots (dial_frequency_hz);
CREATE INDEX IF NOT EXISTS ix_spots_mode_ts ON spots (mode, "timestamp");
CREATE INDEX IF NOT EXISTS ix_spots_callsign_ts ON spots (callsign, "timestamp");
CREATE INDEX IF NOT EXISTS ix_spots_band ON spots (band);
"""

_table_ensured = False

def _ensure_table(db: Session):
    global _table_ensured
    if _table_ensured:
        return
    for stmt in _CREATE_TABLE_SQL.strip().split(";"):
        stmt = stmt.strip()
        if stmt:
            db.execute(text(stmt))
    db.commit()
    _table_ensured = True

# ── browse spots ─────────────────────────────────────────────────────
@router.get("/browse")
def browse_spots(
    mode: str | None = None,
    band: str | None = None,
    callsign: str | None = None,
    hours: int = 24,
    page: int = Query(1, ge=1),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    _ensure_table(db)
    base = "FROM spots WHERE 1=1"
    params: dict = {}

    if mode:
        base += " AND mode = :mode"
        params["mode"] = mode
    if band:
        base += " AND band = :band"
        params["band"] = band
    if callsign:
        base += " AND UPPER(callsign) = UPPER(:callsign)"
        params["callsign"] = callsign
    if hours > 0:
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        base += ' AND "timestamp" >= :cutoff'
        params["cutoff"] = cutoff

    # total count
    row = db.execute(text(f"SELECT COUNT(*) {base}"), params).scalar()
    total = row or 0

    # items
    offset = (page - 1) * limit
    rows = db.execute(
        text(f'SELECT * {base} ORDER BY "timestamp" DESC LIMIT :lim OFFSET :off'),
        {**params, "lim": limit, "off": offset},
    ).mappings().all()

    items = [dict(r) for r in rows]
    # serialize timestamps
    for item in items:
        for k in ("timestamp", "created_at"):
            if isinstance(item.get(k), datetime):
                item[k] = item[k].isoformat()

    return {"total": total, "page": page, "limit": limit, "items": items}

# ── spot map data ────────────────────────────────────────────────────
@router.get("/map")
def spot_map(
    mode: str | None = None,
    band: str | None = None,
    hours: int = 24,
    limit: int = Query(500, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    """Return spots with coordinates for map display (great circle lines)."""
    _ensure_table(db)
    base = "FROM spots WHERE tx_latitude IS NOT NULL AND tx_longitude IS NOT NULL"
    params: dict = {}

    if mode:
        base += " AND mode = :mode"
        params["mode"] = mode
    if band:
        base += " AND band = :band"
        params["band"] = band
    if hours > 0:
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        base += ' AND "timestamp" >= :cutoff'
        params["cutoff"] = cutoff

    rows = db.execute(
        text(f'SELECT callsign, grid, band, mode, snr_db, distance_km, '
             f'tx_latitude, tx_longitude, "timestamp" '
             f'{base} ORDER BY "timestamp" DESC LIMIT :lim'),
        {**params, "lim": limit},
    ).mappings().all()

    items = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("timestamp"), datetime):
            d["timestamp"] = d["timestamp"].isoformat()
        items.append(d)

    return {"spots": items, "total": len(items)}

# ── band activity summary ────────────────────────────────────────────
@router.get("/bands")
def band_activity(
    hours: int = 1,
    db: Session = Depends(get_db),
):
    """Which bands are active right now (spot counts per band/mode)."""
    _ensure_table(db)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.execute(
        text('SELECT band, mode, COUNT(*) as count '
             'FROM spots WHERE "timestamp" >= :cutoff '
             'GROUP BY band, mode ORDER BY count DESC'),
        {"cutoff": cutoff},
    ).mappings().all()
    return {"hours": hours, "bands": [dict(r) for r in rows]}

# ── stats ────────────────────────────────────────────────────────────
@router.get("/stats")
def spot_stats(
    hours: int = 24,
    db: Session = Depends(get_db),
):
    _ensure_table(db)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    params = {"cutoff": cutoff}

    total = db.execute(
        text('SELECT COUNT(*) FROM spots WHERE "timestamp" >= :cutoff'), params
    ).scalar() or 0

    unique_calls = db.execute(
        text('SELECT COUNT(DISTINCT callsign) FROM spots '
             'WHERE "timestamp" >= :cutoff AND callsign IS NOT NULL'), params
    ).scalar() or 0

    by_mode = db.execute(
        text('SELECT mode, COUNT(*) as count FROM spots '
             'WHERE "timestamp" >= :cutoff GROUP BY mode'), params
    ).mappings().all()

    by_band = db.execute(
        text('SELECT band, COUNT(*) as count FROM spots '
             'WHERE "timestamp" >= :cutoff GROUP BY band ORDER BY count DESC'), params
    ).mappings().all()

    top_callsigns = db.execute(
        text('SELECT callsign, COUNT(*) as count FROM spots '
             'WHERE "timestamp" >= :cutoff AND callsign IS NOT NULL '
             'GROUP BY callsign ORDER BY count DESC LIMIT 20'), params
    ).mappings().all()

    farthest = db.execute(
        text('SELECT callsign, grid, band, distance_km, "timestamp" FROM spots '
             'WHERE "timestamp" >= :cutoff AND distance_km IS NOT NULL '
             'ORDER BY distance_km DESC LIMIT 10'), params
    ).mappings().all()
    farthest_list = []
    for r in farthest:
        d = dict(r)
        if isinstance(d.get("timestamp"), datetime):
            d["timestamp"] = d["timestamp"].isoformat()
        farthest_list.append(d)

    # hourly histogram
    hourly = db.execute(
        text("SELECT EXTRACT(HOUR FROM \"timestamp\")::int as hour, COUNT(*) as count "
             "FROM spots WHERE \"timestamp\" >= :cutoff "
             "GROUP BY hour ORDER BY hour"), params
    ).mappings().all()

    return {
        "hours": hours,
        "total_spots": total,
        "unique_callsigns": unique_calls,
        "by_mode": {r["mode"]: r["count"] for r in by_mode},
        "by_band": [dict(r) for r in by_band],
        "top_callsigns": [dict(r) for r in top_callsigns],
        "farthest": farthest_list,
        "by_hour": [dict(r) for r in hourly],
    }
