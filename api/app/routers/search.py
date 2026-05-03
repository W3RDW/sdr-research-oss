import csv
import io
import json
from typing import Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Recording
from ..services.known_freqs import classify_frequency_group, frequency_group_label
from ..services.tagging import extract_callsign_tags, normalize_callsign, parse_ai_tags

router = APIRouter()


def _frequency_group_fields(
    frequency_hz: Optional[float],
    frequency_label: Optional[str],
    mode: Optional[str] = None,
    repeater_id: Optional[int] = None,
) -> dict:
    group = classify_frequency_group(
        frequency_hz=frequency_hz,
        label=frequency_label,
        mode=mode,
        repeater_id=repeater_id,
    )
    return {
        "frequency_group": group,
        "frequency_group_label": frequency_group_label(group),
    }


@router.get("/text")
async def search_text(
    q: str = Query(..., min_length=1),
    mode: Optional[str] = Query(None, pattern="^(cw|voice|aprs)$"),
    frequency_min: Optional[float] = None,
    frequency_max: Optional[float] = None,
    callsign: Optional[str] = Query(None, min_length=1, max_length=20),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    format: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Full-text search on transcripts."""
    search_query = func.plainto_tsquery("english", q)

    query = db.query(
        Recording,
        func.ts_rank(Recording.search_vector, search_query).label("rank"),
        func.ts_headline(
            "english",
            Recording.transcript,
            search_query,
            "StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20",
        ).label("headline"),
    ).filter(Recording.search_vector.op("@@")(search_query))

    if mode:
        query = query.filter(Recording.mode == mode)
    if frequency_min is not None:
        query = query.filter(Recording.frequency_hz >= frequency_min)
    if frequency_max is not None:
        query = query.filter(Recording.frequency_hz <= frequency_max)

    if callsign:
        normalized_callsign = normalize_callsign(callsign)
        if normalized_callsign:
            normalized_transcript = func.regexp_replace(
                func.upper(func.coalesce(Recording.transcript, "")),
                "[^A-Z0-9]+",
                "",
                "g",
            )
            query = query.filter(normalized_transcript.ilike(f"%{normalized_callsign}%"))

    total = query.count()

    if format == "csv":
        csv_rows = query.order_by(text("rank DESC")).limit(5000).all()
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "filename", "mode", "frequency_hz", "frequency_label", "timestamp", "rank", "tags", "headline"])
        for r in csv_rows:
            cs_tags = extract_callsign_tags(r.Recording.transcript)
            ai_tags = parse_ai_tags(r.Recording.ai_tags)
            all_tags = ";".join(list(dict.fromkeys(cs_tags + ai_tags)))
            writer.writerow([
                r.Recording.id,
                r.Recording.filename,
                r.Recording.mode or "",
                r.Recording.frequency_hz or "",
                r.Recording.frequency_label or "",
                r.Recording.timestamp.isoformat() if r.Recording.timestamp else "",
                f"{float(r.rank):.4f}",
                all_tags,
                (r.headline or "").replace("<mark>", "").replace("</mark>", ""),
            ])
        buf.seek(0)
        safe_q = q[:40].replace("/", "_").replace(" ", "_")
        return StreamingResponse(
            iter([buf.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="search_{safe_q}.csv"'},
        )

    results = query.order_by(text("rank DESC")).offset((page - 1) * limit).limit(limit).all()

    return {
        "query": q,
        "total": total,
        "page": page,
        "limit": limit,
        "items": [
            {
                "id": r.Recording.id,
                "filename": r.Recording.filename,
                "mode": r.Recording.mode,
                "frequency_hz": r.Recording.frequency_hz,
                "frequency_label": r.Recording.frequency_label,
                **_frequency_group_fields(
                    r.Recording.frequency_hz,
                    r.Recording.frequency_label,
                    r.Recording.mode,
                    r.Recording.repeater_id,
                ),
                "timestamp": r.Recording.timestamp.isoformat() if r.Recording.timestamp else None,
                "headline": r.headline,
                "rank": float(r.rank),
                "callsign_tags": (callsign_tags := extract_callsign_tags(r.Recording.transcript)),
                "ai_tags": (ai_tags := parse_ai_tags(r.Recording.ai_tags)),
                "tags": list(dict.fromkeys(callsign_tags + ai_tags)),
            }
            for r in results
        ],
    }


@router.get("/callsign")
def search_callsign(
    q: str = Query(..., min_length=1, max_length=100),
):
    """Look up an amateur radio callsign or operator name via FCC ULS, with HamDB fallback."""
    results = []

    # Try FCC ULS first
    try:
        resp = requests.get(
            "https://data.fcc.gov/api/license-view/basicSearch/getLicenses",
            params={"searchValue": q.strip(), "service": "HA", "format": "json", "rows": 25},
            timeout=8.0,
        )
        resp.raise_for_status()
        data = resp.json()
        raw = data.get("Licenses", {}).get("License", [])
        if isinstance(raw, dict):
            raw = [raw]
        for lic in raw:
            callsign = (lic.get("callsign") or "").strip().upper()
            if not callsign:
                continue
            lic_name = (lic.get("licName") or "").strip()
            if "," in lic_name:
                last, _, first = lic_name.partition(",")
                name = f"{first.strip().title()} {last.strip().title()}"
            else:
                name = lic_name.title()
            results.append({
                "callsign": callsign,
                "name": name or None,
                "status": lic.get("statusDesc", ""),
                "expired_date": lic.get("expiredDate") or None,
            })
    except Exception as fcc_err:
        print(f"[LOOKUP] FCC ULS failed: {fcc_err}, trying HamDB fallback", flush=True)

    # Fallback to HamDB if FCC returned nothing
    if not results:
        try:
            from urllib import request as _req
            hamdb_url = f"https://hamdb.org/api/call/{q.strip().upper()}/json"
            hamdb_r = _req.Request(hamdb_url, headers={"User-Agent": "sdr-research/1.0"})
            with _req.urlopen(hamdb_r, timeout=8) as hamdb_resp:
                hamdb_data = json.loads(hamdb_resp.read().decode("utf-8", errors="ignore"))
            cs = hamdb_data.get("hamdb", {}).get("callsign", {})
            status_msg = hamdb_data.get("hamdb", {}).get("messages", {}).get("status", "")
            if status_msg == "OK" and cs:
                fname = (cs.get("fname") or "").strip()
                lname = (cs.get("name") or "").strip()
                full = f"{fname} {lname}".strip() or None
                ham_status = cs.get("status", "").strip().upper()
                results.append({
                    "callsign": (cs.get("call") or q).strip().upper(),
                    "name": full,
                    "status": "Active" if ham_status == "A" else ham_status or "Unknown",
                    "expired_date": cs.get("expdate") or None,
                })
        except Exception as hamdb_err:
            print(f"[LOOKUP] HamDB also failed: {hamdb_err}", flush=True)

    if not results:
        return {"query": q, "results": [], "total": 0}

    return {"query": q, "results": results, "total": len(results)}


@router.get("/similar/{recording_id}")
async def search_similar(
    recording_id: int,
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """Find recordings with transcripts similar to the given recording."""
    rec = db.query(Recording).filter(Recording.id == recording_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Recording not found")
    if not rec.transcript or not rec.search_vector:
        return {"items": [], "total": 0}
    search_query = func.plainto_tsquery("english", rec.transcript[:500])
    results = (
        db.query(
            Recording,
            func.ts_rank(Recording.search_vector, search_query).label("rank"),
        )
        .filter(
            Recording.search_vector.op("@@")(search_query),
            Recording.id != recording_id,
        )
        .order_by(text("rank DESC"))
        .limit(limit)
        .all()
    )
    return {
        "items": [
            {
                "id": r.Recording.id,
                "filename": r.Recording.filename,
                "mode": r.Recording.mode,
                "frequency_hz": r.Recording.frequency_hz,
                "frequency_label": r.Recording.frequency_label,
                **_frequency_group_fields(
                    r.Recording.frequency_hz,
                    r.Recording.frequency_label,
                    r.Recording.mode,
                    r.Recording.repeater_id,
                ),
                "timestamp": r.Recording.timestamp.isoformat() if r.Recording.timestamp else None,
                "transcript": (r.Recording.transcript or "")[:300],
                "rank": float(r.rank),
                "ai_tags": parse_ai_tags(r.Recording.ai_tags),
            }
            for r in results
        ],
        "total": len(results),
    }
