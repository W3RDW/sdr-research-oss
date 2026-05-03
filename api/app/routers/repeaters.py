from typing import Optional

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import asc
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Repeater

router = APIRouter()


@router.get("/station")
async def get_station_center():
    """Return the configured station coordinates (used as map center)."""
    from ..config import settings
    return {
        "latitude": settings.repeaterbook_latitude,
        "longitude": settings.repeaterbook_longitude,
    }


@router.get("")
async def list_repeaters(
    response: Response,
    state: Optional[str] = Query(None, min_length=2, max_length=50),
    callsign: Optional[str] = Query(None, min_length=1, max_length=20),
    frequency_min: Optional[float] = None,
    frequency_max: Optional[float] = None,
    digital_only: bool = False,
    digital_mode: Optional[str] = Query(None, min_length=1, max_length=30),
    page: int = Query(1, ge=1),
    limit: int = Query(100, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    """Browse known repeaters from the local RepeaterBook cache."""
    response.headers["Cache-Control"] = "public, max-age=3600"
    query = db.query(Repeater)

    if state:
        query = query.filter(Repeater.state.ilike(f"%{state}%"))
    if callsign:
        query = query.filter(Repeater.callsign.ilike(f"%{callsign.upper()}%"))
    if frequency_min is not None:
        query = query.filter(Repeater.frequency_hz >= frequency_min)
    if frequency_max is not None:
        query = query.filter(Repeater.frequency_hz <= frequency_max)
    if digital_only or digital_mode:
        query = query.filter(
            Repeater.digital_modes.isnot(None),
            Repeater.digital_modes != "",
        )
    if digital_mode:
        query = query.filter(Repeater.digital_modes.ilike(f"%{digital_mode}%"))

    total = query.count()
    repeaters = (
        query.order_by(asc(Repeater.frequency_hz))
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return {
        "total": total,
        "page": page,
        "limit": limit,
        "items": [
            {
                "id": r.id,
                "callsign": r.callsign,
                "frequency_hz": r.frequency_hz,
                "input_hz": r.input_hz,
                "pl_tone": r.pl_tone,
                "location": r.location,
                "county": r.county,
                "state": r.state,
                "latitude": r.latitude,
                "longitude": r.longitude,
                "use": r.use,
                "digital_modes": [m.strip() for m in r.digital_modes.split(",")] if r.digital_modes else [],
                "linked_nodes": r.linked_nodes,
                "last_synced": r.last_synced.isoformat() if r.last_synced else None,
                "last_heard": r.last_heard.isoformat() if getattr(r, "last_heard", None) else None,
            }
            for r in repeaters
        ],
    }
