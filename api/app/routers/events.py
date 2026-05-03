import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

router = APIRouter()

_subscribers: list[asyncio.Queue] = []


async def broadcast_recording(data: dict):
    """Broadcast a new recording event to all connected SSE clients."""
    for q in list(_subscribers):
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            pass


def _matches_filters(
    data: dict,
    mode: Optional[str],
    frequency_min: Optional[int],
    frequency_max: Optional[int],
    callsign: Optional[str],
) -> bool:
    """Return True if the event data passes all supplied filters."""
    if mode and data.get("mode") != mode:
        return False
    freq = data.get("frequency_hz")
    if frequency_min is not None:
        if freq is None or freq < frequency_min:
            return False
    if frequency_max is not None:
        if freq is None or freq > frequency_max:
            return False
    if callsign:
        callsign_upper = callsign.upper()
        all_tags = (data.get("callsign_tags") or []) + (data.get("ai_tags") or [])
        if not any(callsign_upper in t.upper() for t in all_tags):
            return False
    return True


@router.get("/stream")
async def recordings_stream(
    request: Request,
    mode: Optional[str] = Query(None, description="Filter by mode (voice, cw, aprs, ft8, etc.)"),
    frequency_min: Optional[int] = Query(None, description="Minimum frequency in Hz"),
    frequency_max: Optional[int] = Query(None, description="Maximum frequency in Hz"),
    callsign: Optional[str] = Query(None, description="Filter by callsign in tags"),
):
    """
    Server-Sent Events stream of new recordings as they are indexed.

    Optional query-parameter filters:
    - **mode** — only emit events for this mode (voice, cw, aprs, ft8, etc.)
    - **frequency_min** / **frequency_max** — only emit events within this frequency range (Hz)
    - **callsign** — only emit events that mention this callsign in callsign_tags or ai_tags

    Example: ``/api/v1/events/stream?mode=voice&frequency_min=144000000&frequency_max=148000000``
    """
    has_filters = any(v is not None for v in (mode, frequency_min, frequency_max, callsign))

    async def generator():
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        _subscribers.append(q)
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(q.get(), timeout=25.0)
                    if has_filters and not _matches_filters(
                        data, mode, frequency_min, frequency_max, callsign
                    ):
                        continue
                    yield f"data: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            try:
                _subscribers.remove(q)
            except ValueError:
                pass

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
