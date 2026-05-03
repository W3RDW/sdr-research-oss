"""APRS-IS network client — ingests packets from the APRS Internet System.

Supplements local RF APRS decoding with internet-sourced data for broader
coverage. Packets are stored as mode='aprs' recordings with source_sdr='aprs-is'
to distinguish them from RF-decoded packets.

Controlled by env vars:
  APRS_IS_ENABLED   — "true" to activate (default "false")
  APRS_IS_HOST      — server hostname (default "rotate.aprs2.net")
  APRS_IS_PORT      — server port (default 14580)
  APRS_IS_CALLSIGN  — login callsign (default "N0CALL")
  APRS_IS_FILTER    — server-side filter (default "r/39.0/-84.0/100")
"""
import asyncio
import os
import time as _time
from datetime import datetime

from ..database import SessionLocal
from ..models import Recording
from .alerting import check_alerts
from .metrics import aprs_is_packets_indexed, aprs_is_connected, aprs_packets_indexed
from .known_freqs import classify_frequency_group, frequency_group_label
from .tagging import dump_ai_tags, extract_callsign_tags

APRS_IS_HOST = os.getenv("APRS_IS_HOST", "rotate.aprs2.net")
APRS_IS_PORT = int(os.getenv("APRS_IS_PORT", "14580"))
APRS_IS_CALLSIGN = os.getenv("APRS_IS_CALLSIGN", "N0CALL")
APRS_IS_FILTER = os.getenv("APRS_IS_FILTER", "r/39.0/-84.0/100")
APRS_IS_ENABLED = os.getenv("APRS_IS_ENABLED", "false").lower() == "true"


def _store_packet(packet_line: str, timestamp: datetime):
    """Store a single APRS-IS packet as a Recording row."""
    if ">" not in packet_line or ":" not in packet_line:
        return False
    try:
        callsign = packet_line.split(">")[0].strip()
    except Exception:
        return False
    if not callsign:
        return False

    # Unique filename for dedup — one row per callsign per second
    epoch = int(timestamp.timestamp())
    filename = f"aprs-is_{callsign}_{epoch}.txt"

    db = SessionLocal()
    try:
        existing = db.query(Recording.id).filter(Recording.filename == filename).first()
        if existing:
            return False

        recording = Recording(
            filename=filename,
            mode="aprs",
            frequency_hz=144390000,  # Standard NA APRS-IS frequency (conceptual)
            timestamp=timestamp,
            duration_seconds=None,
            audio_path=None,
            text_path=None,
            transcript=packet_line.strip(),
            source_sdr="aprs-is",
        )

        callsign_tags = extract_callsign_tags(packet_line)
        if callsign_tags:
            recording.ai_tags = dump_ai_tags(callsign_tags)

        check_alerts(recording, db)
        db.add(recording)
        db.commit()

        # Broadcast to SSE subscribers
        try:
            from ..routers.events import broadcast_recording as _broadcast
            _frequency_group = classify_frequency_group(
                frequency_hz=recording.frequency_hz,
                label="APRS-IS",
                mode="aprs",
            )
            asyncio.get_event_loop().call_soon_threadsafe(
                lambda rec=recording, grp=_frequency_group: asyncio.ensure_future(_broadcast({
                    "id": rec.id,
                    "mode": "aprs",
                    "frequency_hz": rec.frequency_hz,
                    "frequency_label": "APRS-IS",
                    "frequency_group": grp,
                    "frequency_group_label": frequency_group_label(grp),
                    "timestamp": rec.timestamp.isoformat() if rec.timestamp else None,
                    "duration_seconds": None,
                    "has_transcript": True,
                    "source_sdr": "aprs-is",
                }))
            )
        except Exception:
            pass

        aprs_is_packets_indexed.inc()
        aprs_packets_indexed.inc()
        return True
    except Exception as e:
        db.rollback()
        print(f"[APRS-IS] DB error storing packet: {e}")
        return False
    finally:
        db.close()


async def run_aprs_is_client():
    """Connect to APRS-IS and ingest packets into the database.

    Long-lived background task. Reconnects automatically on errors.
    Returns immediately if APRS_IS_ENABLED is not 'true'.
    """
    if not APRS_IS_ENABLED:
        print("[APRS-IS] Disabled (set APRS_IS_ENABLED=true to activate)")
        return

    print(f"[APRS-IS] Starting client: {APRS_IS_HOST}:{APRS_IS_PORT} "
          f"callsign={APRS_IS_CALLSIGN} filter={APRS_IS_FILTER}")

    while True:
        writer = None
        try:
            reader, writer = await asyncio.open_connection(
                APRS_IS_HOST, APRS_IS_PORT,
            )
            print(f"[APRS-IS] Connected to {APRS_IS_HOST}:{APRS_IS_PORT}")
            aprs_is_connected.set(1)

            # Login: passcode -1 = receive-only (no TX)
            login_line = (
                f"user {APRS_IS_CALLSIGN} pass -1 vers SDRViewer 1.0 "
                f"filter {APRS_IS_FILTER}\r\n"
            )
            writer.write(login_line.encode())
            await writer.drain()

            greeting = await asyncio.wait_for(reader.readline(), timeout=30)
            print(f"[APRS-IS] Server: {greeting.decode('latin-1').strip()}")

            stored_count = 0
            last_log = _time.time()

            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=90)
                if not line:
                    print("[APRS-IS] Connection closed by server")
                    break

                packet = line.decode("latin-1").strip()
                if not packet or packet.startswith("#"):
                    continue

                now = datetime.utcnow()
                stored = await asyncio.to_thread(_store_packet, packet, now)
                if stored:
                    stored_count += 1

                # Progress log every 60s
                if _time.time() - last_log >= 60:
                    print(f"[APRS-IS] Stored {stored_count} packets in last 60s")
                    stored_count = 0
                    last_log = _time.time()

        except asyncio.CancelledError:
            print("[APRS-IS] Task cancelled, disconnecting")
            aprs_is_connected.set(0)
            if writer is not None:
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass
            raise
        except Exception as e:
            print(f"[APRS-IS] Connection error: {e}, reconnecting in 30s")
            aprs_is_connected.set(0)
            if writer is not None:
                try:
                    writer.close()
                except Exception:
                    pass
            await asyncio.sleep(30)
