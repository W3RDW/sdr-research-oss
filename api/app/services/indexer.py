import asyncio
import json
import os
import re
import time as _time
from datetime import datetime, timedelta
from pathlib import Path
from urllib import error, request

import numpy as np
from sqlalchemy import text

from ..config import settings
from ..database import SessionLocal
from ..models import Recording
from .audio import compute_signal_db
from .alerting import check_alerts
from .hamdb import callsign_context_str, lookup_callsigns
from .known_freqs import classify_frequency_group, frequency_group_label, lookup_known_freq
from .repeater import lookup_repeater, repeater_label
from .tagging import dump_ai_tags, extract_callsign_tags, has_all_ai_tags, is_no_speech_transcript, is_valid_callsign, parse_ai_tags
from .metrics import (
    indexer_files_indexed, indexer_cycle_duration,
    indexer_last_run, indexer_ollama_calls, indexer_ollama_errors,
    aprs_packets_indexed, recordings_total, recordings_with_transcript,
    recordings_with_ai_tags, recordings_with_repeater,
    recordings_pending_transcript, recordings_pending_ai_tags,
    recordings_pending_freq_label, repeater_count, repeater_sync_age_seconds,
    sdr_hardware_last_seen_seconds, sdr_hardware_last_seen, spots_indexed,
)


# Must stay in sync with CALLSIGN_PATTERN in tagging.py
CALLSIGN_TAG_PATTERN = re.compile(
    r"^(?:"
    r"[AKNW][A-Z]?\d[A-Z]{1,3}"
    r"|[A-Z]{1,2}\d[A-Z]{1,4}"
    r"|\d[A-Z]{1,2}\d[A-Z]{1,4}"
    r")$",
    re.IGNORECASE,
)


# ── One-time partition migration ────────────────────────────────
_PARTITION_MODES = [
    "voice", "cw", "aprs", "pager", "hfdl", "acars", "vdl2", "eas", "sstv",
]

def _maybe_partition_recordings():
    """Convert recordings table from regular to LIST-partitioned by mode.

    Idempotent — checks pg_class.relkind and skips if already partitioned ('p').
    Runs once at indexer startup, before the main loop.
    """
    from ..database import engine

    with engine.connect() as conn:
        row = conn.execute(text(
            "SELECT relkind FROM pg_class "
            "WHERE relname = 'recordings' "
            "AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')"
        )).fetchone()
        if row is None:
            print("[Partition] recordings table does not exist yet, skipping")
            return
        if row[0] == 'p':
            print("[Partition] recordings already partitioned, skipping")
            return

        print("[Partition] Converting recordings to LIST partitioning by mode...")

        # Capture current sequence value so we can restore it after the swap.
        seq_row = conn.execute(text(
            "SELECT last_value FROM recordings_id_seq"
        )).fetchone()
        seq_val = seq_row[0] if seq_row else 1

        # 1. Rename existing table (sequence recordings_id_seq stays in place)
        conn.execute(text(
            "ALTER TABLE recordings RENAME TO recordings_unpartitioned"
        ))

        # 2. Create partitioned table reusing the existing sequence
        conn.execute(text("""
            CREATE TABLE recordings (
                id          INTEGER NOT NULL DEFAULT nextval('recordings_id_seq'),
                filename    VARCHAR(255) NOT NULL,
                mode        VARCHAR(10) NOT NULL DEFAULT 'voice',
                frequency_hz    DOUBLE PRECISION,
                timestamp       TIMESTAMP,
                duration_seconds DOUBLE PRECISION,
                audio_path      VARCHAR(512),
                text_path       VARCHAR(512),
                transcript      TEXT,
                ai_tags         TEXT,
                repeater_id     INTEGER,
                frequency_label VARCHAR(255),
                waveform_cached VARCHAR(512),
                spectrogram_cached VARCHAR(512),
                notes           TEXT,
                dtmf_tones      VARCHAR(255),
                signal_db       DOUBLE PRECISION,
                created_at      TIMESTAMP DEFAULT NOW(),
                updated_at      TIMESTAMP DEFAULT NOW(),
                search_vector   TSVECTOR,
                PRIMARY KEY (id, mode)
            ) PARTITION BY LIST (mode)
        """))

        # Reassign sequence ownership to the new table
        conn.execute(text(
            "ALTER SEQUENCE recordings_id_seq OWNED BY recordings.id"
        ))

        # 3. Create a partition for each known mode
        for m in _PARTITION_MODES:
            conn.execute(text(
                f"CREATE TABLE recordings_{m} PARTITION OF recordings "
                f"FOR VALUES IN ('{m}')"
            ))
        # Default partition catches future modes without schema changes
        conn.execute(text(
            "CREATE TABLE recordings_other PARTITION OF recordings DEFAULT"
        ))

        # 4. Recreate indexes (auto-propagated to each partition)
        conn.execute(text(
            "CREATE INDEX ix_recordings_search ON recordings "
            "USING gin (search_vector)"
        ))
        conn.execute(text(
            "CREATE INDEX ix_recordings_timestamp ON recordings (timestamp)"
        ))
        conn.execute(text(
            "CREATE INDEX ix_recordings_filename ON recordings (filename)"
        ))
        conn.execute(text(
            "CREATE UNIQUE INDEX uq_recordings_filename_mode "
            "ON recordings (filename, mode)"
        ))

        # 5. Copy data — COALESCE(mode, 'voice') handles any NULLs
        conn.execute(text("""
            INSERT INTO recordings
                (id, filename, mode, frequency_hz, timestamp, duration_seconds,
                 audio_path, text_path, transcript, ai_tags, repeater_id,
                 frequency_label, waveform_cached, spectrogram_cached, notes,
                 dtmf_tones, signal_db, created_at, updated_at, search_vector)
            SELECT
                id, filename, COALESCE(mode, 'voice'), frequency_hz, timestamp,
                duration_seconds, audio_path, text_path, transcript, ai_tags,
                repeater_id, frequency_label, waveform_cached, spectrogram_cached,
                notes, dtmf_tones, signal_db, created_at, updated_at, search_vector
            FROM recordings_unpartitioned
        """))

        # 6. Restore sequence position
        conn.execute(text(
            f"SELECT setval('recordings_id_seq', {seq_val})"
        ))

        # 7. Drop the old table
        conn.execute(text("DROP TABLE recordings_unpartitioned"))

        conn.commit()

        row_count = conn.execute(text(
            "SELECT count(*) FROM recordings"
        )).fetchone()[0]
        print(
            f"[Partition] Migration complete. {row_count} recordings across "
            f"{len(_PARTITION_MODES)} mode partitions + default."
        )
# ── End partition migration ─────────────────────────────────────


def detect_cw_from_audio(audio_path: str) -> bool:
    """Return True if audio content appears to be CW (Morse code).

    Detects CW by checking for a bimodal dit/dah element structure in the
    amplitude envelope. Works even when CW is sent through FM repeaters,
    where spectral narrowness tests fail due to FM demodulation noise.
    Uses soundfile for fast loading (no resampling needed for envelope detection).
    """
    try:
        import soundfile as sf
        y, sr = sf.read(audio_path, dtype='float32', always_2d=False)
        if y.ndim > 1:
            y = y[:, 0]
    except Exception:
        return False
    if len(y) < sr * 0.3:
        return False

    frame_len = int(sr * 0.020)
    hop = frame_len // 2
    hop_ms = (hop / sr) * 1000
    envelope = np.array([
        float(np.sqrt(np.mean(y[i:i + frame_len] ** 2)))
        for i in range(0, len(y) - frame_len, hop)
    ])
    if len(envelope) < 6:
        return False
    max_env = float(np.max(envelope))
    if max_env == 0:
        return False
    on_off = (envelope / max_env) > 0.25

    current = bool(on_off[0])
    run = 1
    on_runs_ms = []
    for v in on_off[1:]:
        if bool(v) == current:
            run += 1
        else:
            if current:
                on_runs_ms.append(run * hop_ms)
            current = bool(v)
            run = 1
    if current:
        on_runs_ms.append(run * hop_ms)

    cw_elements = [r for r in on_runs_ms if 30 <= r <= 700]
    # Minimum 15 elements: callsign CW IDs have ≥15; raises the false-positive bar.
    if len(cw_elements) < 15:
        return False

    # Rate check: real CW tops out at ~25 WPM = ~2.5 on-elements/s.
    duration_s = len(y) / sr
    if duration_s > 0 and len(cw_elements) / duration_s > 3.0:
        return False

    # Sparsity check: CW is mostly silence (inter-element, inter-char, word gaps).
    # Total on-time should be under half the recording duration.
    total_on_ms = sum(on_runs_ms)
    if duration_s > 0 and (total_on_ms / 1000.0) / duration_s > 0.5:
        return False

    cw_arr = np.array(cw_elements)
    median = float(np.median(cw_arr))
    short_els = cw_arr[cw_arr <= median]
    long_els = cw_arr[cw_arr > median]

    # Require meaningful clusters in both dit and dah groups.
    if len(short_els) < 4 or len(long_els) < 4:
        return False

    short_mean = float(np.mean(short_els))
    long_mean = float(np.mean(long_els))

    if short_mean == 0:
        return False
    ratio = long_mean / short_mean
    # CW standard: dah = 3 × dit. Allow 2–4.5× for speed variation.
    if not (2.0 <= ratio <= 4.5):
        return False

    # Consistency check: dits should be fairly uniform (CV < 0.5).
    # Voice bursts tend to have much higher length variation.
    short_std = float(np.std(short_els))
    if short_mean > 0 and short_std / short_mean > 0.5:
        return False

    return True


# DTMF frequency table: (row_hz, col_hz) -> digit
_DTMF_ROWS = [697, 770, 852, 941]
_DTMF_COLS = [1209, 1336, 1477, 1633]
_DTMF_MAP = {
    (697, 1209): "1", (697, 1336): "2", (697, 1477): "3", (697, 1633): "A",
    (770, 1209): "4", (770, 1336): "5", (770, 1477): "6", (770, 1633): "B",
    (852, 1209): "7", (852, 1336): "8", (852, 1477): "9", (852, 1633): "C",
    (941, 1209): "*", (941, 1336): "0", (941, 1477): "#", (941, 1633): "D",
}


def _goertzel_power(samples: np.ndarray, target_hz: float, sample_rate: int) -> float:
    """Compute Goertzel algorithm power for a single frequency."""
    N = len(samples)
    k = int(0.5 + N * target_hz / sample_rate)
    omega = 2 * np.pi * k / N
    coeff = 2 * np.cos(omega)
    s_prev2 = s_prev = 0.0
    for x in samples:
        s = float(x) + coeff * s_prev - s_prev2
        s_prev2 = s_prev
        s_prev = s
    return s_prev2 ** 2 + s_prev ** 2 - coeff * s_prev * s_prev2


def detect_dtmf_tones(audio_path: str) -> str | None:
    """
    Scan a WAV file for DTMF tones using Goertzel filters.
    Returns a string of detected digits (e.g. '1234#') or None if none found.
    Processes audio in 40ms windows with 50% overlap.
    """
    try:
        import wave
        with wave.open(audio_path, "rb") as wf:
            sr = wf.getframerate()
            nchannels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            raw = wf.readframes(wf.getnframes())
        # Decode PCM
        if sampwidth == 2:
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        elif sampwidth == 1:
            samples = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128.0
        else:
            return None
        if nchannels > 1:
            samples = samples[::nchannels]  # take first channel
        window_size = int(sr * 0.04)   # 40ms
        hop_size = window_size // 2
        if window_size < 64:
            return None
        digits = []
        prev_digit = None
        for start in range(0, len(samples) - window_size, hop_size):
            chunk = samples[start:start + window_size]
            # Energy check — skip silent windows
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            if rms < 0.01:
                prev_digit = None
                continue
            # Find dominant row and col
            row_powers = {f: _goertzel_power(chunk, f, sr) for f in _DTMF_ROWS}
            col_powers = {f: _goertzel_power(chunk, f, sr) for f in _DTMF_COLS}
            best_row = max(row_powers, key=row_powers.get)
            best_col = max(col_powers, key=col_powers.get)
            # Validate: dominant freq should be significantly stronger than others
            row_vals = list(row_powers.values())
            col_vals = list(col_powers.values())
            row_second = sorted(row_vals)[-2] if len(row_vals) > 1 else 0
            col_second = sorted(col_vals)[-2] if len(col_vals) > 1 else 0
            if row_powers[best_row] < row_second * 3:
                prev_digit = None
                continue
            if col_powers[best_col] < col_second * 3:
                prev_digit = None
                continue
            digit = _DTMF_MAP.get((best_row, best_col))
            if digit and digit != prev_digit:
                digits.append(digit)
                prev_digit = digit
            elif not digit:
                prev_digit = None
        return "".join(digits) if len(digits) >= 1 else None
    except Exception as exc:
        print(f"[DTMF] detection error for {audio_path}: {exc}")
        return None


def ensure_recordings_schema(db):
    db.execute(text("ALTER TABLE recordings ADD COLUMN IF NOT EXISTS ai_tags TEXT"))
    db.execute(text("ALTER TABLE recordings ADD COLUMN IF NOT EXISTS repeater_id INTEGER"))
    db.execute(text("ALTER TABLE recordings ADD COLUMN IF NOT EXISTS frequency_label TEXT"))
    db.execute(text("ALTER TABLE recordings ADD COLUMN IF NOT EXISTS notes TEXT"))
    db.execute(text("ALTER TABLE recordings ADD COLUMN IF NOT EXISTS dtmf_tones TEXT"))
    db.execute(text("ALTER TABLE recordings ALTER COLUMN dtmf_tones TYPE TEXT"))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS alert_rules (
            id SERIAL PRIMARY KEY,
            rule_type TEXT NOT NULL,
            value TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            notes TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS frequency_bookmarks (
            id SERIAL PRIMARY KEY,
            frequency_hz FLOAT NOT NULL,
            bandwidth_hz FLOAT DEFAULT 5000.0,
            label TEXT NOT NULL,
            notes TEXT,
            alert_on_activity BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW()
        )
    """))
    # Performance indexes — idempotent, safe to re-run
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_recordings_created_at ON recordings (created_at)"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_recordings_timestamp_desc ON recordings (timestamp DESC)"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_recordings_freq_label_comp ON recordings (frequency_hz, frequency_label)"))
    db.commit()


def safe_unlink(path: str | None):
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass


_prune_cursor_id: int = 0


def prune_missing_recordings():
    global _prune_cursor_id
    db = SessionLocal()
    removed = 0
    pending_delete_ids: list[int] = []
    delete_chunk_size = 500
    scan_batch_size = 4000
    last_seen_id = _prune_cursor_id
    try:
        ensure_recordings_schema(db)
        # Scan only a bounded id window each cycle to keep memory predictable.
        rows = (
            db.query(Recording.id, Recording.audio_path, Recording.text_path, Recording.transcript)
            .filter(Recording.id > _prune_cursor_id)
            .order_by(Recording.id.asc())
            .limit(scan_batch_size)
        )
        for rec_id, audio_path, text_path, transcript in rows:
            last_seen_id = rec_id
            missing = False
            if audio_path:
                missing = not os.path.exists(audio_path)
            elif text_path:
                missing = not os.path.exists(text_path)
            else:
                # DB-only recording (e.g. APRS-IS packets): transcript IS the data.
                # These have no files and must not be pruned.
                missing = transcript is None
            if not missing:
                continue
            pending_delete_ids.append(rec_id)
            if len(pending_delete_ids) >= delete_chunk_size:
                removed += (
                    db.query(Recording)
                    .filter(Recording.id.in_(pending_delete_ids))
                    .delete(synchronize_session=False)
                )
                db.commit()
                pending_delete_ids.clear()
        if pending_delete_ids:
            removed += (
                db.query(Recording)
                .filter(Recording.id.in_(pending_delete_ids))
                .delete(synchronize_session=False)
            )
            db.commit()
        if last_seen_id == _prune_cursor_id:
            # Reached end of table; wrap to beginning next cycle.
            _prune_cursor_id = 0
        else:
            _prune_cursor_id = last_seen_id
        if removed:
            print(f"Pruned {removed} stale recordings (missing files)")
    except Exception as e:
        print(f"Prune error: {e}")
        db.rollback()
    finally:
        db.close()


APRS_BANDS_HZ = (
    (144_370_000, 144_410_000),
    (145_805_000, 145_845_000),
)
# NOAA Weather Radio: 162.400–162.550 MHz (±75 kHz margin covers all 7 channels)
WEATHER_BANDS_HZ = (
    (162_325_000, 162_625_000),
)
# VHF public-safety / pager band — digital data, not voice/CW.
# Skip CW auto-detection and DTMF detection on these frequencies.
PUBLIC_SAFETY_BANDS_HZ = (
    (150_000_000, 162_000_000),
)
APRS_DECODE_FAILED_MARKER = "APRS_DECODE_FAILED"
_INITIAL_INDEX_LOOKBACK_SECONDS = float(os.getenv("INDEX_INITIAL_LOOKBACK_SECONDS", "300"))
_last_index_scan_ts: dict[str, float] = {}
_last_aprs_scan_ts: float = 0.0
_last_pager_scan_ts: float = 0.0
_last_eas_scan_ts: float = 0.0
_last_acars_scan_ts: float = 0.0
_PENDING_SWEEP_INTERVAL = float(os.getenv("PENDING_SWEEP_INTERVAL_SECONDS", "300"))
_last_pending_sweep_ts: float = 0.0


def is_aprs_frequency_hz(frequency_hz: float | None) -> bool:
    if frequency_hz is None:
        return False
    hz = int(round(frequency_hz))
    return any(low <= hz <= high for (low, high) in APRS_BANDS_HZ)

def is_weather_frequency_hz(frequency_hz: float | None) -> bool:
    if frequency_hz is None:
        return False
    hz = int(round(frequency_hz))
    return any(low <= hz <= high for (low, high) in WEATHER_BANDS_HZ)

def is_public_safety_frequency_hz(frequency_hz: float | None) -> bool:
    if frequency_hz is None:
        return False
    hz = int(round(frequency_hz))
    return any(low <= hz <= high for (low, high) in PUBLIC_SAFETY_BANDS_HZ)


def parse_voice_filename(filename: str) -> dict:
    match = re.match(r"(\d+)_(\d+)\.wav$", filename)
    if match:
        freq_hz = float(match.group(1))
        timestamp = datetime.fromtimestamp(int(match.group(2)))
        return {"frequency_hz": freq_hz, "timestamp": timestamp}
    return {}


def parse_cw_filename(filename: str) -> dict:
    match = re.match(r"cw_(\d+)_(\d+)\.wav$", filename)
    if match:
        freq_hz = float(match.group(1))
        timestamp = datetime.fromtimestamp(int(match.group(2)))
        return {"frequency_hz": freq_hz, "timestamp": timestamp}
    match = re.match(r"cw_(\d+)\.wav$", filename)
    if match:
        freq_hz = float(match.group(1))
        return {"frequency_hz": freq_hz}
    return {}


def get_audio_duration(audio_path: str) -> float:
    try:
        import wave as _wav
        with _wav.open(audio_path, "rb") as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return 0.0


def read_transcript(text_path: str) -> str | None:
    if os.path.exists(text_path):
        try:
            with open(text_path, "r") as f:
                return f.read().strip()
        except Exception:
            pass
    return None


def update_search_vector(db, recording_id: int, transcript: str):
    db.execute(
        text(
            "UPDATE recordings SET search_vector = to_tsvector('english', :transcript) WHERE id = :id"
        ),
        {"transcript": transcript, "id": recording_id},
    )
    db.commit()


def sanitize_tag(tag: str) -> str | None:
    text_tag = tag.strip()
    if not text_tag:
        return None
    upper_tag = text_tag.upper()
    if CALLSIGN_TAG_PATTERN.match(upper_tag):
        # Looks like a callsign — validate before accepting
        if is_valid_callsign(upper_tag):
            return upper_tag
        # Failed validation (too short, blacklisted, hallucinated) — drop it
        return None
    lowered = text_tag.lower().replace("-", " ")
    lowered = re.sub(r"[^a-z0-9_ ]+", "", lowered)
    lowered = re.sub(r"\s+", "_", lowered).strip("_")
    if len(lowered) < 2 or len(lowered) > 48:
        return None
    return lowered


def build_ollama_prompt(transcript, callsign_tags, frequency_label=None, repeater_info=None, operator_context=None):
    callsign_context = ", ".join(callsign_tags) if callsign_tags else "none"
    clipped = transcript.strip()
    if len(clipped) > 1600:
        clipped = clipped[:1600]
    context_lines = [f"Known callsigns: {callsign_context}"]
    if operator_context:
        context_lines.append(f"Operators:\n{operator_context}")
    if frequency_label:
        context_lines.append(f"Frequency: {frequency_label}")
    if repeater_info:
        context_lines.append(f"Repeater: {repeater_info}")
    context = "\n".join(context_lines)
    return (
        "/no_think "
        "You tag radio transcripts for later filtering. "
        "Return ONLY valid JSON with this exact schema: "
        "{\"tags\":[\"tag_one\",\"tag_two\"]}. "
        "Rules: 3 to 8 concise tags, no sentences, no duplicates, "
        "prefer lowercase underscore tags, include callsign tags when relevant. "
        "CRITICAL: If the transcript is noise, static, gibberish, a filler phrase "
        "(e.g. 'Thank you for watching', 'Okay', 'Bye', 'You'), or does NOT contain "
        "recognizable radio communication content, return EMPTY tags: {\"tags\":[]}. "
        "Do NOT guess or invent tags for unclear audio. "
        "IMPORTANT: If the transcript mentions emergencies, accidents, injuries, "
        "fires, medical calls, ambulance, police dispatch, pursuit, shots fired, "
        "or any EMS/public safety activity, ALWAYS include the tag \"emergency\". "
        "Also tag with specific type when possible: \"fire\", \"medical\", "
        "\"law_enforcement\", \"accident\", \"hazmat\", \"missing_person\".\n\n"
        f"{context}\n"
        f"Transcript:\n{clipped}"
    )


# Ollama circuit breaker: skip calls after consecutive failures
_ollama_consecutive_failures = 0
_ollama_circuit_open_until = 0.0
_OLLAMA_FAILURE_THRESHOLD = 3
_OLLAMA_COOLDOWN_SECONDS = 300  # 5 min backoff when circuit opens

def generate_ollama_tags(transcript, frequency_label=None, repeater_info=None, operator_context=None):
    global _ollama_consecutive_failures, _ollama_circuit_open_until
    if not settings.ollama_enabled:
        return [], False
    if not transcript or is_no_speech_transcript(transcript):
        return [], False
    # Circuit breaker: skip if in cooldown
    if _time.time() < _ollama_circuit_open_until:
        return extract_callsign_tags(transcript), True
    callsign_tags = extract_callsign_tags(transcript)
    payload = {
        "model": settings.ollama_model,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1},
        "prompt": build_ollama_prompt(
            transcript, callsign_tags,
            frequency_label=frequency_label,
            repeater_info=repeater_info,
            operator_context=operator_context,
        ),
    }
    endpoint = settings.ollama_url.rstrip("/") + "/api/generate"
    req = request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        indexer_ollama_calls.inc()
        with request.urlopen(req, timeout=settings.ollama_timeout_seconds) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
        _ollama_consecutive_failures = 0
    except error.URLError as exc:
        indexer_ollama_errors.inc()
        _ollama_consecutive_failures += 1
        if _ollama_consecutive_failures >= _OLLAMA_FAILURE_THRESHOLD:
            _ollama_circuit_open_until = _time.time() + _OLLAMA_COOLDOWN_SECONDS
            print(f"[Ollama] Circuit breaker OPEN — {_ollama_consecutive_failures} failures, cooling down {_OLLAMA_COOLDOWN_SECONDS}s")
            _ollama_consecutive_failures = 0
        print(f"Ollama request failed: {exc}")
        return callsign_tags, True
    except Exception as exc:
        indexer_ollama_errors.inc()
        _ollama_consecutive_failures += 1
        if _ollama_consecutive_failures >= _OLLAMA_FAILURE_THRESHOLD:
            _ollama_circuit_open_until = _time.time() + _OLLAMA_COOLDOWN_SECONDS
            print(f"[Ollama] Circuit breaker OPEN — {_ollama_consecutive_failures} failures, cooling down {_OLLAMA_COOLDOWN_SECONDS}s")
            _ollama_consecutive_failures = 0
        print(f"Ollama request error: {exc}")
        return callsign_tags, True
    tags: list[str] = []
    seen = set()
    for tag in callsign_tags:
        cleaned = sanitize_tag(tag)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            tags.append(cleaned)
    try:
        outer = json.loads(body)
        response_text = outer.get("response", "")
        # qwen3.5 "thinking" models may put the answer in the thinking field
        if not response_text and outer.get("thinking"):
            response_text = outer["thinking"]
    except Exception:
        response_text = ""
    parsed_tags: list[str] = []
    if response_text:
        try:
            parsed = json.loads(response_text)
            if isinstance(parsed, dict) and isinstance(parsed.get("tags"), list):
                parsed_tags = [str(v) for v in parsed["tags"]]
            elif isinstance(parsed, list):
                parsed_tags = [str(v) for v in parsed]
        except Exception:
            parsed_tags = [p.strip() for p in re.split(r"[,\n]", response_text) if p.strip()]
    max_tags = max(1, settings.ollama_max_tags)
    for raw_tag in parsed_tags:
        cleaned = sanitize_tag(raw_tag)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            tags.append(cleaned)
        if len(tags) >= max_tags:
            break
    return tags, False


# Emergency keyword pre-scan — fast regex before Ollama, guarantees "emergency" tag
_EMERGENCY_PATTERNS = [
    (re.compile(r"\b(fire|structure fire|wildfire|brush fire)\b", re.I), "fire"),
    (re.compile(r"\b(ambulance|medic|ems|medical|cardiac|cpr|overdose|unresponsive)\b", re.I), "medical"),
    (re.compile(r"\b(police|officer|pursuit|shots fired|weapon|robbery|suspect|stolen)\b", re.I), "law_enforcement"),
    (re.compile(r"\b(accident|crash|collision|rollover|mva|mvc)\b", re.I), "accident"),
    (re.compile(r"\b(hazmat|chemical|spill|leak|gas)\b", re.I), "hazmat"),
    (re.compile(r"\b(missing person|missing child|amber alert|silver alert)\b", re.I), "missing_person"),
    (re.compile(r"\b(tornado|flood|severe weather|evacuat)\b", re.I), "severe_weather"),
]

def detect_emergency_tags(transcript: str) -> list[str]:
    """Fast regex pre-scan for emergency/public-safety keywords."""
    if not transcript:
        return []
    tags = []
    for pattern, tag in _EMERGENCY_PATTERNS:
        if pattern.search(transcript):
            tags.append(tag)
    if tags:
        tags.insert(0, "emergency")
    return list(dict.fromkeys(tags))  # dedupe preserving order

def maybe_set_ai_tags(db, recording, transcript, ollama_budget, hamdb_budget=None):
    if recording.ai_tags is not None:
        return
    if not transcript or is_no_speech_transcript(transcript):
        return
    if ollama_budget["remaining"] <= 0 and not settings.ollama_enabled:
        return
    # Fast emergency keyword pre-scan (always runs, no Ollama needed)
    emergency_tags = detect_emergency_tags(transcript)
    seed_tags: list[str] = list(emergency_tags)
    if recording.repeater_id:
        from .repeater import repeater_tags as get_repeater_tags
        from ..models import Repeater
        rptr = db.query(Repeater).filter(Repeater.id == recording.repeater_id).first()
        if rptr:
            seed_tags = list(dict.fromkeys(seed_tags + get_repeater_tags(rptr)))
    if not settings.ollama_enabled:
        recording.ai_tags = dump_ai_tags(seed_tags, allow_empty=True)
        return
    if ollama_budget["remaining"] <= 0:
        if seed_tags:
            recording.ai_tags = dump_ai_tags(seed_tags)
        return
    ollama_budget["remaining"] -= 1
    repeater_info = None
    if recording.repeater_id:
        from ..models import Repeater
        rptr = db.query(Repeater).filter(Repeater.id == recording.repeater_id).first()
        if rptr:
            repeater_info = f"{rptr.callsign} ({rptr.location}, {rptr.state})"
            if rptr.county:
                repeater_info += f", {rptr.county} county"
            if rptr.pl_tone:
                repeater_info += f" PL {rptr.pl_tone:.1f} Hz"
            if rptr.digital_modes:
                repeater_info += f" [{rptr.digital_modes}]"
            if rptr.linked_nodes:
                repeater_info += f" nodes:{rptr.linked_nodes}"
    operator_context = None
    callsigns = extract_callsign_tags(transcript)
    if callsigns and hamdb_budget is not None:
        info_map = lookup_callsigns(db, callsigns, hamdb_budget)
        operator_context = callsign_context_str(info_map)
    tags, ollama_failed = generate_ollama_tags(
        transcript,
        frequency_label=recording.frequency_label,
        repeater_info=repeater_info,
        operator_context=operator_context,
    )
    merged = list(dict.fromkeys(seed_tags + tags))
    serialized = dump_ai_tags(merged, allow_empty=not ollama_failed)
    if serialized is not None:
        recording.ai_tags = serialized


def format_frequency_label(frequency_hz):
    if frequency_hz is None:
        return None
    value = f"{frequency_hz / 1_000_000:.6f}".rstrip("0").rstrip(".")
    return f"{value} MHz"


def should_auto_delete_pager_decode_failed(mode, ai_tags, transcript) -> bool:
    if mode != "pager":
        return False
    if has_all_ai_tags(ai_tags, "pager", "decode_failed"):
        return True
    return bool(transcript and transcript.upper().startswith("PAGER_DECODE_FAILED"))


def should_auto_delete_no_speech(transcript: str | None) -> bool:
    return settings.auto_delete_no_speech and is_no_speech_transcript(transcript)


# Threshold below which a "failed CW decode" recording is treated as noise
# and auto-deleted. Real CW transmissions worth keeping are typically >3s;
# 1-2s hits at narrow bandwidth in 144.1-144.3 MHz are usually SSB voice
# fragments misclassified by the unified-sdr's bandwidth-based slot picker.
_CW_FAILED_MIN_KEEP_SECONDS = 3.0
_CW_FAILED_MARKERS = ("[no decodable cw]", "[cw decode failed]", "")

# Morse characters made up entirely of dots: E (.), I (..), S (...),
# H (....), and 5 (.....). A CW decoder fed pure noise emits long runs
# of dots and chunks them into these chars. Any "transcript" that is
# only these characters (plus whitespace) over an appreciable length is
# decoder garbage, not a real Morse transmission.
_CW_DOTS_ONLY_CHARS = frozenset("EISH5")
_CW_NOISE_MIN_LENGTH = 8  # below this we keep — could be a legit "SOS" / "EE" / "HI HI"


def _cw_transcript_is_failed(transcript: str | None) -> bool:
    if transcript is None:
        return True
    stripped = transcript.strip().lower()
    return stripped in _CW_FAILED_MARKERS


def _cw_transcript_is_dot_noise(transcript: str | None) -> bool:
    """True if the transcript is a long run of dots-only Morse chars only.

    Filters out the gibberish CW decoder output you get when running on
    pure RF noise — long strings like "SEIS EES5EIIHEEIHESSEEEESEES…".
    Real CW transmissions almost always contain at least one non-dot
    character (T, N, A, K, M, O, R, etc.) — even basic abbreviations
    like "DE", "QRZ", "73" use them. A purely dots-only string of
    appreciable length is noise.
    """
    if transcript is None:
        return False
    stripped = transcript.strip().upper()
    # Strip whitespace for char check; whitespace is fine inside CW
    no_space = re.sub(r"\s+", "", stripped)
    if len(no_space) < _CW_NOISE_MIN_LENGTH:
        return False
    return all(c in _CW_DOTS_ONLY_CHARS for c in no_space)


def should_auto_delete_failed_cw(mode: str, duration_seconds: float | None,
                                 transcript: str | None) -> bool:
    """True if this CW recording should be auto-deleted as noise.

    Two cases are caught:
    1. Short (<3s) recordings where the decoder failed entirely (empty
       transcript or failure marker). These are usually narrow SSB voice
       fragments at 144.1-144.3 MHz misclassified into a CW slot by the
       unified-sdr's bandwidth-based mode picker.
    2. ANY duration where the "decoded" transcript is dot-only-Morse
       gibberish (E/I/S/H/5 only, see _cw_transcript_is_dot_noise).
       These are CW decoder output from pure RF noise and surface in
       the UI as "Similar transcripts" full of garbage.
    """
    if mode != "cw":
        return False
    if _cw_transcript_is_dot_noise(transcript):
        return True
    if duration_seconds is None or duration_seconds >= _CW_FAILED_MIN_KEEP_SECONDS:
        return False
    return _cw_transcript_is_failed(transcript)


def maybe_set_frequency_metadata(db, recording):
    if recording.frequency_hz is None:
        return
    if recording.frequency_label is None:
        # Check user-defined DB labels first, then fall back to static known_freqs
        try:
            db_label = db.execute(
                text(
                    "SELECT label FROM frequency_labels"
                    " WHERE ABS(frequency_hz - :f) <= COALESCE(bandwidth_hz, 5000)"
                    " ORDER BY ABS(frequency_hz - :f) LIMIT 1"
                ),
                {"f": recording.frequency_hz},
            ).first()
            if db_label:
                recording.frequency_label = db_label[0]
        except Exception:
            pass
        if recording.frequency_label is None:
            label = lookup_known_freq(recording.frequency_hz)
            if label:
                recording.frequency_label = label
    if recording.repeater_id is None:
        rptr = lookup_repeater(db, recording.frequency_hz)
        if rptr:
            recording.repeater_id = rptr.id
            recording.frequency_label = repeater_label(rptr)
    # Update repeater last_heard timestamp
    if recording.repeater_id and recording.timestamp:
        try:
            db.execute(
                text("UPDATE repeaters SET last_heard = :ts WHERE id = :rid AND (last_heard IS NULL OR last_heard < :ts)"),
                {"ts": recording.timestamp, "rid": recording.repeater_id},
            )
        except Exception:
            pass
    if recording.frequency_label is None:
        recording.frequency_label = format_frequency_label(recording.frequency_hz)


def _touch_heartbeat():
    """Update liveness heartbeat from any thread."""
    try:
        with open("/tmp/indexer_heartbeat", "w") as _f:
            _f.write(str(_time.time()))
    except Exception:
        pass

# Time budget per index_directory call — prevents one mode from starving others
_INDEX_TIME_BUDGET_SEC = float(os.getenv("INDEX_TIME_BUDGET_SEC", "30"))

def index_directory(mode: str, audio_dir: str, text_dir: str, ollama_budget: dict, hamdb_budget: dict | None = None):
    global _last_index_scan_ts
    db = SessionLocal()
    try:
        ensure_recordings_schema(db)
        audio_path = Path(audio_dir)
        if not audio_path.exists():
            return
        now_ts = _time.time()
        scan_key = f"{mode}:{audio_path.name}"
        previous_scan = _last_index_scan_ts.get(scan_key, 0.0)
        if previous_scan <= 0:
            scan_since_ts = now_ts - _INITIAL_INDEX_LOOKBACK_SECONDS
        else:
            scan_since_ts = previous_scan - 2.0
        processed = 0
        _last_hb_ts = _time.time()
        _budget_deadline = _time.time() + _INDEX_TIME_BUDGET_SEC
        # Fast filename-based prefilter: parse epoch from {freq}_{epoch}.wav
        # to skip old files without NFS stat() calls.
        try:
            all_names = os.listdir(audio_dir)
        except OSError:
            return
        wav_names = []
        for fn in all_names:
            if not fn.endswith(".wav"):
                continue
            parts = fn[:-4].split("_")
            if len(parts) >= 2:
                try:
                    file_epoch = int(parts[-1])
                    if file_epoch < scan_since_ts:
                        continue
                except ValueError:
                    pass
            wav_names.append(fn)
        # Sort newest first so fresh recordings are indexed before old backlog
        wav_names.sort(key=lambda fn: fn.split("_")[-1] if "_" in fn else fn, reverse=True)
        for fname in wav_names:
            wav_file = Path(audio_dir) / fname
            try:
                _stat = wav_file.stat()
                file_mtime = _stat.st_mtime
                file_size = _stat.st_size
            except Exception:
                continue
            if file_mtime < scan_since_ts:
                continue
            # 0-byte WAVs are SDR squelch artifacts — there is nothing to
            # decode and creating a Recording row would just leave the
            # transcript pending forever. Drop the file and skip.
            if file_size == 0:
                safe_unlink(str(wav_file))
                continue
            processed += 1
            # Time budget: yield to other indexers after deadline
            if _time.time() > _budget_deadline:
                print(f"[{mode}] Time budget reached after {processed} files, yielding", flush=True)
                break
            # Heartbeat every 60s so liveness probe stays happy during big batches
            if _time.time() - _last_hb_ts > 60:
                _touch_heartbeat()
                _last_hb_ts = _time.time()
            if processed % 250 == 0:
                # Keep ORM identity map bounded during large scans.
                db.expunge_all()
            filename = wav_file.name
            if mode == "voice":
                metadata = parse_voice_filename(filename)
                # APRS-band captures are indexed only by the APRS pipeline.
                if is_aprs_frequency_hz(metadata.get("frequency_hz")):
                    continue
                # NOAA weather radio — delete WAV and skip; never index.
                if is_weather_frequency_hz(metadata.get("frequency_hz")):
                    safe_unlink(str(wav_file))
                    continue
            else:
                metadata = parse_cw_filename(filename)
            text_path = os.path.join(text_dir, filename.replace(".wav", ".txt"))
            existing = db.query(Recording).filter(Recording.filename == filename).first()
            if existing:
                if should_auto_delete_no_speech(existing.transcript):
                    safe_unlink(existing.audio_path)
                    safe_unlink(existing.text_path)
                    safe_unlink(existing.waveform_cached)
                    safe_unlink(existing.spectrogram_cached)
                    db.delete(existing)
                    db.commit()
                    print(f"Auto-deleted no-speech recording: {filename}")
                    continue
                if should_auto_delete_failed_cw(existing.mode, existing.duration_seconds, existing.transcript):
                    safe_unlink(existing.audio_path)
                    safe_unlink(existing.text_path)
                    safe_unlink(existing.waveform_cached)
                    safe_unlink(existing.spectrogram_cached)
                    db.delete(existing)
                    db.commit()
                    print(f"Auto-deleted short failed-CW recording: {filename} ({existing.duration_seconds:.1f}s)")
                    continue
                if existing.transcript is None:
                    transcript = read_transcript(text_path)
                    if transcript:
                        if should_auto_delete_no_speech(transcript):
                            safe_unlink(str(wav_file))
                            safe_unlink(text_path)
                            db.delete(existing)
                            db.commit()
                            print(f"Auto-deleted no-speech recording: {filename}")
                            continue
                        existing.text_path = text_path
                        existing.transcript = transcript
                        update_search_vector(db, existing.id, transcript)
                maybe_set_frequency_metadata(db, existing)
                maybe_set_ai_tags(db, existing, existing.transcript, ollama_budget, hamdb_budget)
                check_alerts(existing, db)
                db.commit()
                continue
            timestamp = metadata.get("timestamp")
            if timestamp is None:
                try:
                    timestamp = datetime.fromtimestamp(file_mtime)
                except Exception:
                    timestamp = None
            duration = get_audio_duration(str(wav_file))
            # Auto-delete very short voice recordings (<2s) — mostly squelch tails and noise bursts
            if mode == "voice" and duration is not None and duration < 2.0:
                _rec_freq_check = metadata.get("frequency_hz") or 0
                # Keep APRS (very short bursts are valid) and pager
                if not is_aprs_frequency_hz(_rec_freq_check) and not is_public_safety_frequency_hz(_rec_freq_check):
                    safe_unlink(str(wav_file))
                    safe_unlink(text_path)
                    print(f"Auto-deleted short voice recording ({duration:.1f}s): {filename}")
                    continue
            transcript = read_transcript(text_path)
            if should_auto_delete_no_speech(transcript):
                safe_unlink(str(wav_file))
                safe_unlink(text_path)
                print(f"Auto-deleted no-speech recording: {filename}")
                continue
            # Auto-delete short CW recordings whose decoder failed — usually
            # narrow SSB voice fragments misclassified into a CW slot by the
            # unified-sdr's bandwidth-based mode picker.
            if should_auto_delete_failed_cw(mode, duration, transcript):
                safe_unlink(str(wav_file))
                safe_unlink(text_path)
                print(f"Auto-deleted short failed-CW recording ({duration:.1f}s): {filename}")
                continue
            effective_mode = mode
            _rec_freq = metadata.get("frequency_hz")
            if mode == "voice" and not is_public_safety_frequency_hz(_rec_freq):
                try:
                    if detect_cw_from_audio(str(wav_file)):
                        effective_mode = "cw"
                        transcript = None
                        safe_unlink(text_path)
                        print(f"[CW-DETECT] Reclassified {filename} as CW")
                except Exception as _cw_err:
                    print(f"[CW-DETECT] Error on {filename}: {_cw_err}")
            recording = Recording(
                filename=filename,
                mode=effective_mode,
                frequency_hz=metadata.get("frequency_hz"),
                timestamp=timestamp,
                duration_seconds=duration,
                audio_path=str(wav_file),
                text_path=text_path if transcript else None,
                transcript=transcript,
            )
            recording.signal_db = compute_signal_db(str(wav_file))
            # Infer source SDR from audio directory and frequency
            _dir_name = audio_path.name  # voice, cw, pager
            _freq = metadata.get("frequency_hz") or 0
            if _dir_name == "pager" or (150e6 <= _freq <= 162e6):
                recording.source_sdr = "rtl-pager"
            elif 420e6 <= _freq <= 450e6:
                recording.source_sdr = "rtl-70cm"
            elif 130e6 <= _freq <= 180e6:
                recording.source_sdr = "airspy-2m"
            elif _freq < 64e6:
                recording.source_sdr = "rx888-hf"
            else:
                recording.source_sdr = "airspy-2m"
            maybe_set_frequency_metadata(db, recording)
            # DTMF detection for voice recordings (skip public-safety/pager digital data)
            if effective_mode == "voice" and recording.audio_path and not is_public_safety_frequency_hz(_rec_freq):
                try:
                    dtmf = detect_dtmf_tones(recording.audio_path)
                    if dtmf:
                        recording.dtmf_tones = dtmf[:255]
                        print(f"[DTMF] '{recording.dtmf_tones}' in {filename}")
                except Exception as _dtmf_err:
                    print(f"[DTMF] error on {filename}: {_dtmf_err}")
            # Weather radio auto-tagging
            if recording.frequency_label and "NOAA WX" in recording.frequency_label:
                wx_tags = ["weather_radio"]
                if recording.transcript:
                    t_upper = recording.transcript.upper()
                    if any(k in t_upper for k in [
                        "TORNADO", "FLOOD", "SEVERE", "EMERGENCY",
                        "WARNING", "WATCH", "ADVISORY", "SAME",
                    ]):
                        wx_tags.append("weather_alert")
                existing_ai = parse_ai_tags(recording.ai_tags)
                recording.ai_tags = dump_ai_tags(list(dict.fromkeys(wx_tags + existing_ai)))
            maybe_set_ai_tags(db, recording, transcript, ollama_budget, hamdb_budget)
            check_alerts(recording, db)
            # Frequency bookmark activity webhook
            try:
                if recording.frequency_hz and settings.alert_webhook_url:
                    bm_rows = db.execute(
                        text(
                            "SELECT id, label FROM frequency_bookmarks"
                            " WHERE alert_on_activity = TRUE"
                            " AND ABS(frequency_hz - :f) <= COALESCE(bandwidth_hz, 5000)"
                        ),
                        {"f": recording.frequency_hz},
                    ).fetchall()
                    for bm in bm_rows:
                        from ..services.alerting import _send_webhook
                        _send_webhook({
                            "type": "bookmark_activity",
                            "bookmark_id": bm.id,
                            "bookmark_label": bm.label,
                            "recording_id": recording.id if recording.id else 0,
                            "filename": recording.filename,
                            "frequency_hz": recording.frequency_hz,
                            "frequency_label": recording.frequency_label,
                            "timestamp": recording.timestamp.isoformat() if recording.timestamp else None,
                        })
            except Exception as _bm_err:
                print(f"[Bookmark] activity check error: {_bm_err}")
            db.add(recording)
            db.commit()
            if transcript:
                update_search_vector(db, recording.id, transcript)
            indexer_files_indexed.labels(mode=effective_mode).inc()
            print(f"Indexed: {filename}")
            try:
                import asyncio as _asyncio
                from ..routers.events import broadcast_recording as _broadcast
                _cs_tags = extract_callsign_tags(recording.transcript)
                _ai_tags = parse_ai_tags(recording.ai_tags)
                from ..routers.files import _transcript_status
                _frequency_group = classify_frequency_group(
                    frequency_hz=recording.frequency_hz,
                    label=recording.frequency_label,
                    mode=recording.mode,
                    repeater_id=recording.repeater_id,
                )
                _asyncio.get_event_loop().call_soon_threadsafe(
                    lambda grp=_frequency_group: _asyncio.ensure_future(_broadcast({
                        "id": recording.id,
                        "mode": recording.mode,
                        "frequency_hz": recording.frequency_hz,
                        "frequency_label": recording.frequency_label,
                        "frequency_group": grp,
                        "frequency_group_label": frequency_group_label(grp),
                        "timestamp": recording.timestamp.isoformat() if recording.timestamp else None,
                        "duration_seconds": recording.duration_seconds,
                        "has_transcript": bool((recording.transcript or "").strip()),
                        "transcript_status": _transcript_status(recording),
                        "signal_db": recording.signal_db,
                        "callsign_tags": _cs_tags,
                        "ai_tags": _ai_tags,
                    }))
                )
            except Exception:
                pass
        _last_index_scan_ts[scan_key] = now_ts
    except Exception as e:
        print(f"Indexer error: {e}")
        db.rollback()
    finally:
        db.close()


def index_aprs_directory(text_dir: str):
    """Index APRS packets from text-only files (audio deleted after decode)."""
    global _last_aprs_scan_ts
    db = SessionLocal()
    try:
        ensure_recordings_schema(db)
        text_path = Path(text_dir)
        if not text_path.exists():
            return
        now_ts = _time.time()
        if _last_aprs_scan_ts <= 0:
            scan_since_ts = now_ts - _INITIAL_INDEX_LOOKBACK_SECONDS
        else:
            # Small overlap to avoid missing files around scan boundaries.
            scan_since_ts = _last_aprs_scan_ts - 2.0
        processed = 0
        for txt_file in text_path.glob("*.txt"):
            try:
                file_mtime = txt_file.stat().st_mtime
            except Exception:
                continue
            if file_mtime < scan_since_ts:
                continue
            processed += 1
            wav_name = txt_file.name.replace(".txt", ".wav")
            existing = db.query(Recording).filter(Recording.filename == wav_name).first()
            if existing:
                continue
            metadata = parse_voice_filename(wav_name)
            timestamp = metadata.get("timestamp")
            if timestamp is None:
                try:
                    timestamp = datetime.fromtimestamp(file_mtime)
                except Exception:
                    timestamp = None
            transcript = read_transcript(str(txt_file))
            if not transcript:
                continue
            transcript = transcript.strip()
            if not transcript:
                continue
            decode_failed = transcript.upper().startswith(APRS_DECODE_FAILED_MARKER)
            recording = Recording(
                filename=wav_name,
                mode="aprs",
                frequency_hz=metadata.get("frequency_hz"),
                timestamp=timestamp,
                duration_seconds=None,
                audio_path=None,
                text_path=str(txt_file),
                transcript=transcript,
            )
            maybe_set_frequency_metadata(db, recording)
            if decode_failed:
                recording.ai_tags = dump_ai_tags(["aprs", "decode_failed"])
            else:
                # Tag with callsigns from the packet (no Ollama for structured APRS data)
                callsign_tags = extract_callsign_tags(transcript)
                if callsign_tags:
                    recording.ai_tags = dump_ai_tags(callsign_tags)
            check_alerts(recording, db)
            db.add(recording)
            db.flush()  # assign ID without committing
            if transcript:
                update_search_vector(db, recording.id, transcript)
            aprs_packets_indexed.inc()
            print(f"Indexed APRS: {txt_file.name}")
            # Batch commit every 50 records for throughput
            if processed % 50 == 0:
                db.commit()
                db.expunge_all()
        db.commit()  # flush remaining batch
        _last_aprs_scan_ts = now_ts
    except Exception as e:
        print(f"APRS indexer error: {e}")
        db.rollback()
    finally:
        db.close()


def _index_text_only_directory(mode: str, text_dir: str, last_ts_ref: list, failed_marker: str):
    """
    Generic indexer for text-only decoder outputs: pager, eas, acars.
    Filename format matches the voice WAV that was decoded: {freq}_{ts}.txt
    last_ts_ref is a single-element list used as a mutable float reference.
    """
    db = SessionLocal()
    try:
        ensure_recordings_schema(db)
        text_path = Path(text_dir)
        if not text_path.exists():
            return
        now_ts = _time.time()
        if last_ts_ref[0] <= 0:
            scan_since_ts = now_ts - _INITIAL_INDEX_LOOKBACK_SECONDS
        else:
            scan_since_ts = last_ts_ref[0] - 2.0
        processed = 0
        _pending_inserts = 0
        for txt_file in text_path.glob("*.txt"):
            try:
                file_mtime = txt_file.stat().st_mtime
            except Exception:
                continue
            if file_mtime < scan_since_ts:
                continue
            processed += 1
            wav_name = txt_file.name.replace(".txt", ".wav")
            existing = db.query(Recording).filter(Recording.filename == wav_name).first()
            if existing:
                if should_auto_delete_pager_decode_failed(existing.mode, existing.ai_tags, existing.transcript):
                    safe_unlink(existing.waveform_cached)
                    safe_unlink(existing.spectrogram_cached)
                    db.delete(existing)
                    db.commit()
                    print(f"Auto-deleted pager decode_failed record: {wav_name}")
                    continue
                continue
            metadata = parse_voice_filename(wav_name)
            timestamp = metadata.get("timestamp")
            if timestamp is None:
                try:
                    timestamp = datetime.fromtimestamp(file_mtime)
                except Exception:
                    timestamp = None
            transcript = read_transcript(str(txt_file))
            if not transcript:
                continue
            transcript = transcript.strip()
            if not transcript:
                continue
            decode_failed = transcript.upper().startswith(failed_marker.upper())
            recording = Recording(
                filename=wav_name,
                mode=mode,
                frequency_hz=metadata.get("frequency_hz"),
                timestamp=timestamp,
                duration_seconds=None,
                audio_path=None,
                text_path=str(txt_file),
                transcript=transcript,
            )
            maybe_set_frequency_metadata(db, recording)
            if decode_failed:
                recording.ai_tags = dump_ai_tags([mode, "decode_failed"])
                if should_auto_delete_pager_decode_failed(recording.mode, recording.ai_tags, recording.transcript):
                    print(f"Auto-deleted pager decode_failed record: {wav_name}")
                    continue
            else:
                callsign_tags = extract_callsign_tags(transcript)
                mode_tag = [mode]
                recording.ai_tags = dump_ai_tags(mode_tag + callsign_tags)
            check_alerts(recording, db)
            db.add(recording)
            db.flush()  # assign ID without committing
            if transcript:
                update_search_vector(db, recording.id, transcript)
            _pending_inserts += 1
            indexer_files_indexed.labels(mode=mode).inc()
            print(f"Indexed {mode.upper()}: {txt_file.name}")
            # Batch commit every 50 records for throughput
            if _pending_inserts % 50 == 0:
                db.commit()
                db.expunge_all()
        db.commit()  # flush remaining batch
        last_ts_ref[0] = now_ts
    except Exception as e:
        print(f"{mode.upper()} indexer error: {e}")
        db.rollback()
    finally:
        db.close()


_pager_ts = [0.0]
_eas_ts = [0.0]
_acars_ts = [0.0]
_vdl2_ts = [0.0]
_hfdl_ts = [0.0]
_sstv_ts = [0.0]


def index_pager_directory(text_dir: str):
    _index_text_only_directory("pager", text_dir, _pager_ts, "PAGER_DECODE_FAILED")


def _cleanup_pager_decode_failed_records(batch_size: int = 5000):
    """Delete pager records tagged as decode_failed while keeping decoder marker files."""
    db = SessionLocal()
    try:
        rows = (
            db.query(Recording)
            .filter(Recording.mode == "pager")
            .order_by(Recording.id.asc())
            .limit(batch_size)
            .all()
        )
        if not rows:
            return
        deleted = 0
        for rec in rows:
            if not should_auto_delete_pager_decode_failed(rec.mode, rec.ai_tags, rec.transcript):
                continue
            safe_unlink(rec.waveform_cached)
            safe_unlink(rec.spectrogram_cached)
            db.delete(rec)
            deleted += 1
        if deleted:
            db.commit()
            print(f"[PAGER CLEANUP] Deleted {deleted} pager decode_failed recording(s)")
    except Exception as e:
        print(f"[PAGER CLEANUP] error: {e}")
        db.rollback()
    finally:
        db.close()


def index_eas_directory(text_dir: str):
    _index_text_only_directory("eas", text_dir, _eas_ts, "EAS_NO_ALERT")


def index_acars_directory(text_dir: str):
    _index_text_only_directory("acars", text_dir, _acars_ts, "ACARS_DECODE_FAILED")


def index_vdl2_directory(text_dir: str):
    _index_text_only_directory("vdl2", text_dir, _vdl2_ts, "VDL2_DECODE_FAILED")


def _parse_hfdl_frame(frame: dict) -> tuple[str, dict]:
    """Parse a dumphfdl JSON frame. Returns (decoded_text, metadata_dict)."""
    freq_hz = frame.get("freq", 0)
    t = frame.get("t", {})
    ts_sec = t.get("sec", 0)
    hfdl = frame.get("hfdl", {})
    station = hfdl.get("station", {})
    station_name = station.get("name", "")
    lpdu_type = hfdl.get("lpdu", {}).get("type", {}).get("name", "")
    parts = []
    if station_name:
        parts.append(f"GS:{station_name}")
    if lpdu_type:
        parts.append(f"[{lpdu_type}]")
    app_info = hfdl.get("app_info", {})
    flight = app_info.get("flight", "")
    reg = app_info.get("reg", "")
    if flight:
        parts.append(f"FLT:{flight}")
    if reg:
        parts.append(f"REG:{reg}")
    acars = app_info.get("acars", {})
    if acars:
        label = acars.get("label", "")
        msg_text = acars.get("msg_text", "")
        if label:
            parts.append(f"LBL:{label}")
        if msg_text:
            parts.append(f"MSG:{msg_text.strip()[:200]}")
    spdu = hfdl.get("spdu", {})
    if spdu:
        ac_list = spdu.get("ac_info", []) or []
        callsigns = [ac.get("ac_id", "") for ac in ac_list if ac.get("ac_id")]
        if callsigns:
            parts.append("AC:" + ",".join(callsigns))
    decoded_text = " | ".join(parts) if parts else f"HFDL frame @ {freq_hz / 1e6:.3f} MHz"
    metadata = {
        "frequency_hz": float(freq_hz),
        "timestamp": datetime.fromtimestamp(ts_sec) if ts_sec else None,
        "station": station_name,
        "flight": flight,
        "reg": reg,
    }
    return decoded_text, metadata


def index_hfdl_directory(text_dir: str):
    """Index HFDL frames from dumphfdl JSON files (one JSON file per decoded frame)."""
    db = SessionLocal()
    try:
        ensure_recordings_schema(db)
        text_path = Path(text_dir)
        if not text_path.exists():
            return
        now_ts = _time.time()
        if _hfdl_ts[0] <= 0:
            scan_since_ts = now_ts - _INITIAL_INDEX_LOOKBACK_SECONDS
        else:
            scan_since_ts = _hfdl_ts[0] - 2.0
        processed = 0
        for json_file in text_path.glob("*.json"):
            try:
                file_mtime = json_file.stat().st_mtime
            except Exception:
                continue
            if file_mtime < scan_since_ts:
                continue
            processed += 1
            if processed % 500 == 0:
                db.expunge_all()
            filename = json_file.name
            existing = db.query(Recording).filter(Recording.filename == filename).first()
            if existing:
                continue
            try:
                with open(json_file) as _f:
                    frame = json.load(_f)
            except Exception:
                continue
            decoded_text, metadata = _parse_hfdl_frame(frame)
            timestamp = metadata.get("timestamp")
            if timestamp is None:
                try:
                    timestamp = datetime.fromtimestamp(file_mtime)
                except Exception:
                    timestamp = None
            # Parse frequency and timestamp from filename: hfdl_{freq}_{ts_ms}.json
            _m = re.match(r"hfdl_(\d+)_(\d+)\.json$", filename)
            if _m:
                if not metadata.get("frequency_hz"):
                    metadata["frequency_hz"] = float(_m.group(1))
                if timestamp is None:
                    try:
                        timestamp = datetime.fromtimestamp(int(_m.group(2)) / 1000)
                    except Exception:
                        pass
            recording = Recording(
                filename=filename,
                mode="hfdl",
                frequency_hz=metadata.get("frequency_hz"),
                timestamp=timestamp,
                duration_seconds=None,
                audio_path=None,
                text_path=str(json_file),
                transcript=decoded_text,
            )
            maybe_set_frequency_metadata(db, recording)
            tags = ["hfdl"]
            if metadata.get("flight"):
                tags.append("aviation")
            if metadata.get("reg"):
                clean_reg = metadata["reg"].lower().replace("-", "").replace(" ", "")
                if clean_reg:
                    tags.append(clean_reg)
            recording.ai_tags = dump_ai_tags(tags)
            db.add(recording)
            db.commit()
            if decoded_text:
                update_search_vector(db, recording.id, decoded_text)
            indexer_files_indexed.labels(mode="hfdl").inc()
            print(f"Indexed HFDL: {filename}")
        _hfdl_ts[0] = now_ts
    except Exception as e:
        print(f"HFDL indexer error: {e}")
        db.rollback()
    finally:
        db.close()


def index_sstv_directory(image_dir: str):
    """Index SSTV captured images from /data/images/sstv/ (PNG/JPEG files).
    Image path is stored in audio_path; no audio involved."""
    db = SessionLocal()
    try:
        ensure_recordings_schema(db)
        image_path = Path(image_dir)
        if not image_path.exists():
            return
        now_ts = _time.time()
        if _sstv_ts[0] <= 0:
            scan_since_ts = now_ts - _INITIAL_INDEX_LOOKBACK_SECONDS
        else:
            scan_since_ts = _sstv_ts[0] - 2.0
        processed = 0
        for img_file in list(image_path.glob("*.png")) + list(image_path.glob("*.jpg")):
            try:
                file_mtime = img_file.stat().st_mtime
            except Exception:
                continue
            if file_mtime < scan_since_ts:
                continue
            processed += 1
            if processed % 200 == 0:
                db.expunge_all()
            filename = img_file.name
            existing = db.query(Recording).filter(Recording.filename == filename).first()
            if existing:
                continue
            frequency_hz = None
            timestamp = None
            # Parse: sstv_{freq_hz}_{unix_ts}.png
            _m2 = re.match(r"sstv_(\d+)_(\d+)\.(png|jpg)$", filename, re.IGNORECASE)
            if _m2:
                frequency_hz = float(_m2.group(1))
                try:
                    timestamp = datetime.fromtimestamp(int(_m2.group(2)))
                except Exception:
                    pass
            if timestamp is None:
                try:
                    timestamp = datetime.fromtimestamp(file_mtime)
                except Exception:
                    timestamp = None
            recording = Recording(
                filename=filename,
                mode="sstv",
                frequency_hz=frequency_hz,
                timestamp=timestamp,
                duration_seconds=None,
                audio_path=str(img_file),  # image path stored in audio_path field
                text_path=None,
                transcript=None,
            )
            maybe_set_frequency_metadata(db, recording)
            recording.ai_tags = dump_ai_tags(["sstv", "image"])
            db.add(recording)
            db.commit()
            indexer_files_indexed.labels(mode="sstv").inc()
            print(f"Indexed SSTV: {filename}")
        _sstv_ts[0] = now_ts
    except Exception as e:
        print(f"SSTV indexer error: {e}")
        db.rollback()
    finally:
        db.close()


# ── FT8/WSPR spot indexer ──────────────────────────────────────────
_ft8_ts: list[float] = [0.0]

def index_ft8_directory(text_dir: str):
    """Index FT8/WSPR/FT4 decoded spot JSON files from /data/text/ft8/.
    Each file contains one spot dict written by the ft8-wspr-decoder pod.
    Spots are inserted into the 'spots' table (not 'recordings')."""
    from sqlalchemy import text as sa_text
    db = SessionLocal()
    try:
        # Ensure spots table exists (same DDL as spots.py router)
        db.execute(sa_text("""
            CREATE TABLE IF NOT EXISTS spots (
                id SERIAL PRIMARY KEY,
                "timestamp" TIMESTAMP NOT NULL,
                mode VARCHAR(10) NOT NULL,
                dial_frequency_hz BIGINT NOT NULL,
                audio_offset_hz INTEGER,
                snr_db REAL, dt REAL,
                callsign VARCHAR(20), grid VARCHAR(10),
                power_dbm INTEGER, message VARCHAR(255),
                band VARCHAR(10), distance_km REAL,
                tx_latitude REAL, tx_longitude REAL,
                created_at TIMESTAMP DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS ix_spots_timestamp ON spots ("timestamp");
            CREATE INDEX IF NOT EXISTS ix_spots_mode ON spots (mode);
            CREATE INDEX IF NOT EXISTS ix_spots_callsign ON spots (callsign);
            CREATE INDEX IF NOT EXISTS ix_spots_band ON spots (band);
        """))
        db.commit()

        ft8_path = Path(text_dir)
        if not ft8_path.exists():
            return
        now_ts = _time.time()
        # Process every JSON file in the directory. Successful inserts are
        # unlinked after commit, and the dedup-by-(mode,callsign,freq,ts)
        # check guards against double-counting on retry, so a full scan is
        # safe and ensures any files left behind by a previous crash or a
        # missed cycle window get backfilled instead of accumulating
        # forever. The directory is small (one decoder writing tiny files).
        processed = 0
        _pending_json_files = []
        for json_file in ft8_path.glob("*.json"):
            processed += 1
            try:
                with open(json_file) as f:
                    spot = json.load(f)
            except (json.JSONDecodeError, OSError):
                continue

            # Parse timestamp
            ts_str = spot.get("timestamp")
            ts = None
            if ts_str:
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    if ts.tzinfo:
                        ts = ts.replace(tzinfo=None)
                except Exception:
                    pass
            if ts is None:
                ts = datetime.utcnow()

            mode = spot.get("mode", "ft8")
            dial_hz = spot.get("dial_frequency_hz", 0)
            callsign = spot.get("callsign")

            # Deduplicate: same mode + callsign + dial_freq within 30 seconds
            if callsign:
                dup = db.execute(sa_text(
                    'SELECT id FROM spots WHERE mode = :mode '
                    'AND callsign = :call AND dial_frequency_hz = :freq '
                    'AND ABS(EXTRACT(EPOCH FROM ("timestamp" - :ts))) < 30 '
                    'LIMIT 1'
                ), {"mode": mode, "call": callsign, "freq": dial_hz, "ts": ts}).first()
                if dup:
                    _pending_json_files.append(json_file)
                    continue

            db.execute(sa_text(
                'INSERT INTO spots ("timestamp", mode, dial_frequency_hz, '
                'audio_offset_hz, snr_db, dt, callsign, grid, power_dbm, '
                'message, band, distance_km, tx_latitude, tx_longitude) '
                'VALUES (:ts, :mode, :dial, :aoff, :snr, :dt, :call, :grid, '
                ':power, :msg, :band, :dist, :lat, :lon)'
            ), {
                "ts": ts, "mode": mode, "dial": dial_hz,
                "aoff": spot.get("audio_offset_hz"),
                "snr": spot.get("snr_db"), "dt": spot.get("dt"),
                "call": callsign, "grid": spot.get("grid"),
                "power": spot.get("power_dbm"),
                "msg": spot.get("message", "")[:255],
                "band": spot.get("band"),
                "dist": spot.get("distance_km"),
                "lat": spot.get("tx_latitude"),
                "lon": spot.get("tx_longitude"),
            })
            spots_indexed.labels(mode=mode).inc()
            _pending_json_files.append(json_file)
            # Batch commit every 50 spots; delete JSON only after commit
            if processed % 50 == 0:
                db.commit()
                for _jf in _pending_json_files:
                    try:
                        _jf.unlink()
                    except OSError:
                        pass
                _pending_json_files.clear()
                db.expunge_all()
        db.commit()  # flush remaining batch
        for _jf in _pending_json_files:
            try:
                _jf.unlink()
            except OSError:
                pass
        _ft8_ts[0] = now_ts
    except Exception as e:
        print(f"FT8/WSPR indexer error: {e}")
        db.rollback()
    finally:
        db.close()


def _refresh_db_gauges():
    """Query DB and update Prometheus gauge metrics. Called once per cycle."""
    from sqlalchemy import func as _func
    from ..models import Repeater
    _db = SessionLocal()
    try:
        for _mode, _cnt in _db.query(Recording.mode, _func.count(Recording.id)).group_by(Recording.mode).all():
            if _mode:
                recordings_total.labels(mode=_mode).set(_cnt)
        recordings_with_transcript.set(
            _db.query(_func.count(Recording.id)).filter(Recording.transcript.isnot(None)).scalar() or 0
        )
        recordings_with_ai_tags.set(
            _db.query(_func.count(Recording.id)).filter(Recording.ai_tags.isnot(None)).scalar() or 0
        )
        recordings_with_repeater.set(
            _db.query(_func.count(Recording.id)).filter(Recording.repeater_id.isnot(None)).scalar() or 0
        )
        recordings_pending_transcript.set(
            _db.query(_func.count(Recording.id)).filter(
                Recording.mode.in_(["voice", "cw"]), Recording.transcript.is_(None)
            ).scalar() or 0
        )
        recordings_pending_ai_tags.set(
            _db.query(_func.count(Recording.id)).filter(
                Recording.ai_tags.is_(None), Recording.transcript.isnot(None)
            ).scalar() or 0
        )
        recordings_pending_freq_label.set(
            _db.query(_func.count(Recording.id)).filter(
                Recording.frequency_hz.isnot(None), Recording.frequency_label.is_(None)
            ).scalar() or 0
        )
        repeater_count.set(_db.query(_func.count(Repeater.id)).scalar() or 0)
        _last_synced = _db.query(_func.max(Repeater.last_synced)).scalar()
        if _last_synced:
            repeater_sync_age_seconds.set(_time.time() - _last_synced.timestamp())
        # Per-band hardware last-seen (labeled) + global unlabeled
        _SOURCE_BAND_MAP = {
            "rtl-pager": "pager",
            "rtl-70cm": "70cm",
            "airspy-2m": "2m",
            "rx888-hf": "HF",
        }
        _now = _time.time()
        _global_max_ts = None
        for _src, _max_ts in (
            _db.query(Recording.source_sdr, _func.max(Recording.timestamp))
            .filter(Recording.source_sdr.isnot(None))
            .group_by(Recording.source_sdr)
            .all()
        ):
            if _src and _max_ts:
                _band = _SOURCE_BAND_MAP.get(_src, _src)
                _age = _now - _max_ts.timestamp()
                sdr_hardware_last_seen.labels(band=_band, source_sdr=_src).set(_age)
                if _global_max_ts is None or _max_ts > _global_max_ts:
                    _global_max_ts = _max_ts
        if _global_max_ts:
            sdr_hardware_last_seen_seconds.set(_now - _global_max_ts.timestamp())
    except Exception as _e:
        print(f"[metrics] DB gauge refresh error: {_e}")
    finally:
        _db.close()


# Track last auto-retention and digest run times
_last_auto_retention: float = 0.0
_last_daily_digest: float = 0.0
_last_digest_sent: datetime | None = None
_AUTO_RETENTION_INTERVAL = 86400.0   # 24 hours
_DAILY_DIGEST_INTERVAL = 86400.0     # 24 hours


# Per-mode retention overrides (days). Modes not listed here use RETENTION_DAYS as default.
# Parsed from RETENTION_MODE_DAYS env var: "pager:30,eas:365,aprs:180,hfdl:30,vdl2:30,acars:30"
_RETENTION_MODE_DAYS: dict[str, int] = {}
_raw_mode_days = os.environ.get("RETENTION_MODE_DAYS", "")
if _raw_mode_days:
    for _pair in _raw_mode_days.split(","):
        _pair = _pair.strip()
        if ":" in _pair:
            _m, _d = _pair.split(":", 1)
            try:
                _RETENTION_MODE_DAYS[_m.strip()] = int(_d.strip())
            except ValueError:
                pass

def _run_auto_retention():
    """Delete recordings older than RETENTION_DAYS with per-mode overrides. Runs at most once per day."""
    if settings.retention_days <= 0:
        return
    default_days = settings.retention_days
    db = SessionLocal()
    try:
        # Build per-mode cutoffs
        now = datetime.utcnow()
        mode_cutoffs: dict[str, datetime] = {}
        for mode_name, days in _RETENTION_MODE_DAYS.items():
            if days > 0:
                mode_cutoffs[mode_name] = now - timedelta(days=days)
        default_cutoff = now - timedelta(days=default_days)

        # Query all recordings older than the most aggressive (shortest) cutoff
        # so we don't miss any mode with shorter retention than the default
        most_recent_cutoff = default_cutoff
        for mc in mode_cutoffs.values():
            if mc > most_recent_cutoff:
                most_recent_cutoff = mc
        recordings = db.query(Recording).filter(Recording.timestamp < most_recent_cutoff).all()

        deleted = 0
        deleted_by_mode: dict[str, int] = {}
        for rec in recordings:
            rec_mode = rec.mode or "unknown"
            cutoff = mode_cutoffs.get(rec_mode, default_cutoff)
            if rec.timestamp >= cutoff:
                continue  # not yet expired for this mode
            for path in [rec.audio_path, rec.text_path, rec.waveform_cached, rec.spectrogram_cached]:
                if path:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
            db.delete(rec)
            deleted += 1
            deleted_by_mode[rec_mode] = deleted_by_mode.get(rec_mode, 0) + 1
        db.commit()
        if deleted:
            breakdown = ", ".join(f"{m}={c}" for m, c in sorted(deleted_by_mode.items()))
            print(f"[AutoRetention] Deleted {deleted} recordings (default {default_days}d, overrides: {_RETENTION_MODE_DAYS}). Breakdown: {breakdown}")
    except Exception as exc:
        print(f"[AutoRetention] error: {exc}")
        db.rollback()
    finally:
        db.close()


def _send_daily_digest():
    """Send a daily summary webhook with recording stats."""
    if not settings.alert_webhook_url:
        return
    db = SessionLocal()
    try:
        from sqlalchemy import func as _func
        cutoff_24h = datetime.utcnow() - timedelta(hours=24)
        total_24h = db.query(_func.count(Recording.id)).filter(
            Recording.timestamp >= cutoff_24h
        ).scalar() or 0
        by_mode = {}
        for mode, cnt in db.query(Recording.mode, _func.count(Recording.id)).filter(
            Recording.timestamp >= cutoff_24h
        ).group_by(Recording.mode).all():
            by_mode[mode or "unknown"] = cnt
        top_freqs = db.query(
            Recording.frequency_label, _func.count(Recording.id).label("cnt")
        ).filter(
            Recording.timestamp >= cutoff_24h,
            Recording.frequency_label.isnot(None),
        ).group_by(Recording.frequency_label).order_by(
            _func.count(Recording.id).desc()
        ).limit(5).all()
        from ..services.alerting import _send_webhook
        _send_webhook({
            "type": "daily_digest",
            "period_hours": 24,
            "total_recordings": total_24h,
            "by_mode": by_mode,
            "top_frequencies": [{"label": lbl, "count": cnt} for lbl, cnt in top_freqs],
            "generated_at": datetime.utcnow().isoformat(),
        })
        print(f"[DailyDigest] Sent: {total_24h} recordings in last 24h")
    except Exception as exc:
        print(f"[DailyDigest] error: {exc}")
    finally:
        db.close()


_CW_NODECODE_TIMEOUT = float(os.getenv("CW_NODECODE_TIMEOUT_SECONDS", "900"))
# Voice recordings whose .txt never appears (Whisper crashed, audio empty,
# etc.) are stamped after this many seconds so they leave the pending state.
_VOICE_NOTRANSCRIPT_TIMEOUT = float(
    os.getenv("VOICE_NOTRANSCRIPT_TIMEOUT_SECONDS", "3600")
)

def _sweep_pending_transcripts(ollama_budget, hamdb_budget):
    """
    Query DB for voice/CW recordings with transcript=None and check whether
    their .txt file has since appeared on disk.  This covers the gap where
    Whisper finishes AFTER the WAV file falls outside the incremental scan
    window (i.e., all recordings created in a previous scan cycle).

    Also handles two edge cases:
    - Reclassified CW (audio in voice dir): text is written by voice decoder
      to the voice text dir, not the cw text dir.
    - CW files where decoder found no Morse: no .txt is ever written; after
      CW_NODECODE_TIMEOUT seconds we stamp them as '[no decodable cw]' so
      they leave the pending state.
    """
    global _last_pending_sweep_ts
    db = SessionLocal()
    try:
        pending = (
            db.query(Recording)
            .filter(
                Recording.mode.in_(["voice", "cw"]),
                Recording.transcript.is_(None),
                Recording.audio_path.isnot(None),
            )
            .all()
        )
        updated = 0
        now = _time.time()
        for rec in pending:
            # Derive text_path: base it on the actual audio directory so
            # reclassified-CW files (audio in voice/) find the voice .txt.
            if rec.text_path:
                text_path = rec.text_path
            else:
                base = os.path.basename(rec.audio_path).replace(".wav", ".txt")
                # Pager-routed FM audio still lands in the voice text
                # directory, even though the WAV is stored under /audio/pager.
                if (
                    os.sep + "voice" + os.sep in rec.audio_path
                    or rec.audio_path.endswith(os.sep + "voice")
                    or os.sep + "pager" + os.sep in rec.audio_path
                    or rec.audio_path.endswith(os.sep + "pager")
                ):
                    sub = "voice"
                else:
                    sub = "cw"
                text_path = os.path.join(settings.text_base_path, sub, base)

            transcript = read_transcript(text_path)
            if not transcript:
                # CW files where the decoder found nothing write no .txt.
                # After a timeout, stamp them so they leave pending state.
                if rec.mode == "cw":
                    try:
                        wav_age = now - os.path.getmtime(rec.audio_path)
                    except OSError:
                        wav_age = _CW_NODECODE_TIMEOUT + 1
                    if wav_age >= _CW_NODECODE_TIMEOUT:
                        # No decodable CW — delete the file and row
                        # rather than keeping a useless stub.
                        safe_unlink(rec.audio_path)
                        if rec.text_path:
                            safe_unlink(rec.text_path)
                        db.delete(rec)
                        db.commit()
                        updated += 1
                elif rec.mode == "voice":
                    # Empty / missing WAVs can never be transcribed —
                    # the SDR occasionally writes a 0-byte file when
                    # squelch closes immediately. Drop the row + file
                    # right away so it stops occupying the pending count.
                    try:
                        wav_size = os.path.getsize(rec.audio_path)
                        wav_age = now - os.path.getmtime(rec.audio_path)
                    except OSError:
                        wav_size = 0
                        wav_age = _VOICE_NOTRANSCRIPT_TIMEOUT + 1
                    if wav_size <= 0:
                        safe_unlink(rec.audio_path)
                        if rec.text_path:
                            safe_unlink(rec.text_path)
                        db.delete(rec)
                        db.commit()
                        updated += 1
                    elif wav_age >= _VOICE_NOTRANSCRIPT_TIMEOUT:
                        # Whisper had its chance — stamp the row as failed
                        # so it leaves pending. Audio is preserved in case
                        # we want to retry later by hand.
                        rec.transcript = "[no transcribable audio]"
                        db.commit()
                        updated += 1
                continue
            if should_auto_delete_no_speech(transcript):
                safe_unlink(rec.audio_path)
                safe_unlink(text_path)
                db.delete(rec)
                db.commit()
                continue
            rec.text_path = text_path
            rec.transcript = transcript
            update_search_vector(db, rec.id, transcript)
            maybe_set_ai_tags(db, rec, transcript, ollama_budget, hamdb_budget)
            check_alerts(rec, db)
            db.commit()
            updated += 1
        if updated:
            print(f"[PendingSweep] Resolved {updated} pending transcript(s)")
    except Exception as e:
        print(f"[PendingSweep] error: {e}")
        db.rollback()
    finally:
        db.close()
    _last_pending_sweep_ts = _time.time()


def _purge_no_decodable_cw():
    """Delete [no decodable cw] records that accumulated from CW false positives."""
    db = SessionLocal()
    try:
        recs = (
            db.query(Recording)
            .filter(
                Recording.mode == "cw",
                Recording.transcript == "[no decodable cw]",
            )
            .all()
        )
        count = 0
        for rec in recs:
            if rec.audio_path:
                safe_unlink(rec.audio_path)
            if rec.text_path:
                safe_unlink(rec.text_path)
            db.delete(rec)
            count += 1
        if count:
            db.commit()
            print(f"[CW-PURGE] Deleted {count} [no decodable cw] records")
    except Exception as e:
        print(f"[CW-PURGE] error: {e}")
        db.rollback()
    finally:
        db.close()


def _backfill_frequency_labels(batch_size: int = 5000):
    """Backfill frequency_label and repeater_id for existing recordings missing them."""
    db = SessionLocal()
    try:
        rows = (
            db.query(Recording)
            .filter(
                Recording.frequency_hz.isnot(None),
                Recording.frequency_label.is_(None),
            )
            .order_by(Recording.id.asc())
            .limit(batch_size)
            .all()
        )
        if not rows:
            return
        updated = 0
        for rec in rows:
            maybe_set_frequency_metadata(db, rec)
            if rec.frequency_label is not None:
                updated += 1
        db.commit()
        print(f"[BACKFILL] Labeled {updated}/{len(rows)} recordings")
    except Exception as e:
        print(f"[BACKFILL] error: {e}")
        db.rollback()
    finally:
        db.close()

def _backfill_ai_tags(batch_size: int = 1000, ollama_budget: dict | None = None, hamdb_budget: dict | None = None):
    """Backfill ai_tags for existing transcripts missing them."""
    db = SessionLocal()
    try:
        rows = (
            db.query(Recording)
            .filter(
                Recording.transcript.isnot(None),
                Recording.ai_tags.is_(None),
            )
            .order_by(Recording.id.asc())
            .limit(batch_size)
            .all()
        )
        if not rows:
            return
        updated = 0
        local_ollama_budget = ollama_budget if ollama_budget is not None else {
            "remaining": max(0, settings.ollama_max_per_cycle)
        }
        local_hamdb_budget = hamdb_budget if hamdb_budget is not None else {
            "remaining": max(0, settings.hamdb_max_per_cycle)
        }
        for rec in rows:
            before_tags = rec.ai_tags
            maybe_set_frequency_metadata(db, rec)
            maybe_set_ai_tags(db, rec, rec.transcript, local_ollama_budget, local_hamdb_budget)
            if rec.ai_tags != before_tags:
                updated += 1
        db.commit()
        print(f"[AI BACKFILL] Tagged {updated}/{len(rows)} recordings")
    except Exception as e:
        print(f"[AI BACKFILL] error: {e}")
        db.rollback()
    finally:
        db.close()

def _cleanup_short_recordings():
    """Delete voice recordings <2s that are already in the DB (one-time cleanup)."""
    db = SessionLocal()
    try:
        short = (
            db.query(Recording)
            .filter(
                Recording.mode == "voice",
                Recording.duration_seconds.isnot(None),
                Recording.duration_seconds < 2.0,
            )
            .limit(200)
            .all()
        )
        if not short:
            return
        deleted = 0
        for rec in short:
            # Keep APRS and pager frequencies
            freq = rec.frequency_hz or 0
            if is_aprs_frequency_hz(freq) or is_public_safety_frequency_hz(freq):
                continue
            safe_unlink(rec.audio_path)
            safe_unlink(rec.text_path)
            safe_unlink(rec.waveform_cached)
            safe_unlink(rec.spectrogram_cached)
            db.delete(rec)
            deleted += 1
        if deleted:
            db.commit()
            print(f"[CLEANUP] Deleted {deleted} short voice recordings (<2s)")
    except Exception as e:
        print(f"[CLEANUP] error: {e}")
        db.rollback()
    finally:
        db.close()

async def run_indexer():
    # Write heartbeat immediately so liveness probe doesn't kill us during a long first cycle
    try:
        with open("/tmp/indexer_heartbeat", "w") as _hb:
            _hb.write(str(_time.time()))
    except Exception:
        pass

    # One-time migration: partition recordings table by mode for 500k+ scale
    try:
        await asyncio.to_thread(_maybe_partition_recordings)
    except Exception as _part_err:
        print(f"[Partition] Migration error (non-fatal): {_part_err}")

    # Purge any [no decodable cw] stubs left over from before auto-delete
    try:
        await asyncio.to_thread(_purge_no_decodable_cw)
    except Exception as _cw_purge_err:
        print(f"[CW-PURGE] Error (non-fatal): {_cw_purge_err}")

    # Launch APRS-IS client as a sibling background task (opt-in via env var)
    try:
        from .aprs_is import run_aprs_is_client
        asyncio.create_task(run_aprs_is_client())
    except Exception as _aprs_is_err:
        print(f"[APRS-IS] Failed to start: {_aprs_is_err}")

    while True:
        _cycle_start = _time.time()
        # Refresh heartbeat at cycle start so a slow-but-healthy cycle
        # doesn't starve the liveness probe (which checks every 60s, kills
        # after 3 failures if heartbeat > 600s old).
        try:
            with open("/tmp/indexer_heartbeat", "w") as _hb:
                _hb.write(str(_time.time()))
        except Exception:
            pass
        try:
            def _hb():
                try:
                    with open("/tmp/indexer_heartbeat", "w") as _f:
                        _f.write(str(_time.time()))
                except Exception:
                    pass

            ollama_budget = {"remaining": max(0, settings.ollama_max_per_cycle)}
            hamdb_budget = {"remaining": max(0, settings.hamdb_max_per_cycle)}

            # ── FAST PATH — lightweight text/JSON indexers first ──
            # These scan small directories and must never be starved by voice backlog.
            # HF_TEXT_BASE_PATH points to the separate sdr-artifacts-hf PVC mount.
            _hf_text = os.environ.get("HF_TEXT_BASE_PATH", settings.text_base_path)
            await asyncio.to_thread(
                index_ft8_directory,
                text_dir=os.path.join(_hf_text, "ft8"),
            )
            _hb()

            await asyncio.to_thread(
                index_hfdl_directory,
                text_dir=os.path.join(_hf_text, "hfdl"),
            )
            _hb()

            await asyncio.to_thread(
                index_aprs_directory,
                text_dir=os.path.join(settings.text_base_path, "aprs"),
            )
            _hb()

            await asyncio.to_thread(
                index_pager_directory,
                text_dir=os.path.join(settings.text_base_path, "pager"),
            )
            _hb()

            await asyncio.to_thread(
                index_eas_directory,
                text_dir=os.path.join(settings.text_base_path, "eas"),
            )
            _hb()

            await asyncio.to_thread(
                index_acars_directory,
                text_dir=os.path.join(settings.text_base_path, "acars"),
            )
            _hb()

            await asyncio.to_thread(
                index_vdl2_directory,
                text_dir=os.path.join(settings.text_base_path, "vdl2"),
            )
            _hb()

            await asyncio.to_thread(
                index_sstv_directory,
                image_dir="/data/images/sstv",
            )
            _hb()

            # ── SLOW PATH — large audio directories with time budget ──
            # Each gets INDEX_TIME_BUDGET_SEC (default 30s) before yielding.
            # Unfinished files are picked up next cycle (newest first).
            await asyncio.to_thread(
                index_directory,
                mode="voice",
                audio_dir=os.path.join(settings.audio_base_path, "voice"),
                text_dir=os.path.join(settings.text_base_path, "voice"),
                ollama_budget=ollama_budget,
                hamdb_budget=hamdb_budget,
            )
            _hb()

            await asyncio.to_thread(
                index_directory,
                mode="cw",
                audio_dir=os.path.join(settings.audio_base_path, "cw"),
                text_dir=os.path.join(settings.text_base_path, "cw"),
                ollama_budget=ollama_budget,
                hamdb_budget=hamdb_budget,
            )
            _hb()

            _pager_audio_dir = os.path.join(settings.audio_base_path, "pager")
            if os.path.isdir(_pager_audio_dir):
                await asyncio.to_thread(
                    index_directory,
                    mode="voice",
                    audio_dir=_pager_audio_dir,
                    text_dir=os.path.join(settings.text_base_path, "voice"),
                    ollama_budget=ollama_budget,
                    hamdb_budget=hamdb_budget,
                )
            _hb()

            # ── MAINTENANCE — cleanup and backfill ──
            await asyncio.to_thread(prune_missing_recordings)
            _hb()

            await asyncio.to_thread(_cleanup_pager_decode_failed_records, 5000)
            _hb()

            await asyncio.to_thread(_backfill_frequency_labels, 5000)
            _hb()

            await asyncio.to_thread(_backfill_ai_tags, 1000, ollama_budget, hamdb_budget)
            _hb()

            await asyncio.to_thread(_cleanup_short_recordings)
            _hb()

            # Sweep for recordings whose Whisper .txt appeared after the WAV
            # fell outside the incremental scan window.
            if _time.time() - _last_pending_sweep_ts >= _PENDING_SWEEP_INTERVAL:
                await asyncio.to_thread(
                    _sweep_pending_transcripts, ollama_budget, hamdb_budget
                )

            await asyncio.to_thread(_refresh_db_gauges)

        except Exception as e:
            print(f"Indexer cycle error: {e}")

        indexer_cycle_duration.observe(_time.time() - _cycle_start)
        indexer_last_run.set(_time.time())

        # Scheduled auto-retention (once per day)
        global _last_auto_retention
        if _time.time() - _last_auto_retention >= _AUTO_RETENTION_INTERVAL:
            try:
                await asyncio.to_thread(_run_auto_retention)
                _last_auto_retention = _time.time()
            except Exception as _ar_err:
                print(f"[AutoRetention] task error: {_ar_err}")

        # Daily digest webhook (once per day, offset 1 hour from retention)
        global _last_daily_digest
        if _time.time() - _last_daily_digest >= _DAILY_DIGEST_INTERVAL:
            try:
                await asyncio.to_thread(_send_daily_digest)
                _last_daily_digest = _time.time()
            except Exception as _dd_err:
                print(f"[DailyDigest] task error: {_dd_err}")

        # SDR hardware health — parse timestamp from filename; no stat calls.
        # With 30k+ WAV files, glob+getmtime blocks for minutes. os.listdir
        # + filename regex runs in ~1s in a thread and doesn't touch the event loop.
        try:
            def _sdr_health():
                import re as _re
                _ts_re = _re.compile(r"_(\d+)\.wav$")
                voice_dir = os.path.join(settings.audio_base_path, "voice")
                max_ts = max(
                    (int(m.group(1)) for f in os.listdir(voice_dir)
                     if (m := _ts_re.search(f))),
                    default=None,
                )
                if max_ts is not None:
                    sdr_hardware_last_seen_seconds.set(_time.time() - max_ts)
            await asyncio.to_thread(_sdr_health)
        except Exception:
            pass

        # Heartbeat for liveness probe
        try:
            with open("/tmp/indexer_heartbeat", "w") as _hb:
                _hb.write(str(_time.time()))
        except Exception:
            pass

        await asyncio.sleep(30)
