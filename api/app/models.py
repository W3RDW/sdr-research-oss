from datetime import datetime
from sqlalchemy import Column, Integer, BigInteger, String, DateTime, Text, Float, Index, Boolean
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR

from .database import Base


class CallsignInfo(Base):
    """Local cache of HamDB callsign lookups."""
    __tablename__ = "callsign_cache"

    callsign = Column(String(20), primary_key=True)
    name = Column(String(255), nullable=True)       # "First Last"
    qth_city = Column(String(100), nullable=True)
    qth_state = Column(String(4), nullable=True)
    license_class = Column(String(10), nullable=True)  # T/G/A/E
    grid = Column(String(10), nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    active = Column(Boolean, nullable=True)
    fetched_at = Column(DateTime, nullable=True)


class Repeater(Base):
    __tablename__ = "repeaters"

    id = Column(Integer, primary_key=True, index=True)
    callsign = Column(String(20), index=True)
    frequency_hz = Column(Float, index=True)   # output (listen) frequency in Hz
    input_hz = Column(Float, nullable=True)    # input frequency in Hz
    pl_tone = Column(Float, nullable=True)     # CTCSS tone Hz; None = no tone / unknown
    location = Column(String(255), nullable=True)
    county = Column(String(100), nullable=True)
    state = Column(String(50), nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    use = Column(String(20), nullable=True)          # OPEN, CLOSED, PRIVATE
    digital_modes = Column(String(100), nullable=True)  # CSV: DMR, P25, D-Star, etc.
    linked_nodes = Column(String(255), nullable=True)   # EchoLink/IRLP/AllStar node info
    last_synced = Column(DateTime, nullable=True)
    last_heard = Column(DateTime, nullable=True)  # updated when a recording matches this repeater

    __table_args__ = (
        Index("ix_repeaters_frequency", "frequency_hz"),
    )


class Recording(Base):
    __tablename__ = "recordings"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String(255), unique=True, index=True)
    mode = Column(String(10), index=True)  # 'cw' or 'voice'
    frequency_hz = Column(Float, nullable=True, index=True)
    timestamp = Column(DateTime, nullable=True, index=True)
    duration_seconds = Column(Float, nullable=True)
    audio_path = Column(String(512))
    text_path = Column(String(512), nullable=True)
    transcript = Column(Text, nullable=True)
    ai_tags = Column(JSONB, nullable=True)       # JSONB list of tags
    repeater_id = Column(Integer, nullable=True)  # FK to repeaters.id (soft ref)
    frequency_label = Column(String(255), nullable=True)  # human label for the frequency
    waveform_cached = Column(String(512), nullable=True)
    spectrogram_cached = Column(String(512), nullable=True)
    notes = Column(Text, nullable=True)           # operator-written notes
    dtmf_tones = Column(String(255), nullable=True)  # detected DTMF sequence, e.g. "12*#"
    signal_db = Column(Float, nullable=True)          # RMS signal level in dBFS
    source_sdr = Column(String(30), nullable=True)   # hardware source: airspy-2m, rtl-70cm, rtl-pager, rx888-hf
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Full-text search vector
    search_vector = Column(TSVECTOR)

    __table_args__ = (
        Index("ix_recordings_search", "search_vector", postgresql_using="gin"),
        Index("ix_recordings_freq_ts", "frequency_hz", "timestamp"),
        Index("ix_recordings_repeater_id", "repeater_id"),
        Index("ix_recordings_freq_label", "frequency_label"),
        Index("ix_recordings_source_sdr", "source_sdr"),
    )


class AlertHistory(Base):
    """History of fired alerts (keyword/callsign matches)."""
    __tablename__ = "alert_history"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)
    recording_id = Column(Integer, nullable=True)
    filename = Column(String(255), nullable=True)
    frequency_hz = Column(Float, nullable=True)
    frequency_label = Column(String(255), nullable=True)
    transcript_excerpt = Column(Text, nullable=True)
    matched = Column(Text, nullable=True)  # JSON list of matched conditions


class FrequencyBookmark(Base):
    """User-saved frequency bookmarks with optional activity alerts."""
    __tablename__ = "frequency_bookmarks"

    id = Column(Integer, primary_key=True, index=True)
    frequency_hz = Column(Float, nullable=False, index=True)
    bandwidth_hz = Column(Float, nullable=True, default=5000.0)  # match tolerance in Hz
    label = Column(String(255), nullable=False)
    notes = Column(Text, nullable=True)
    alert_on_activity = Column(Boolean, default=False)  # fire webhook when activity heard
    created_at = Column(DateTime, default=datetime.utcnow)


class FrequencyLabel(Base):
    """User-defined frequency labels stored in the database (override known_freqs.py)."""
    __tablename__ = "frequency_labels"

    id = Column(Integer, primary_key=True, index=True)
    frequency_hz = Column(Float, nullable=False, index=True)
    bandwidth_hz = Column(Float, nullable=True)  # match tolerance in Hz; default 5000
    label = Column(String(255), nullable=False)
    mode = Column(String(20), nullable=True)      # voice / cw / aprs / None = any
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Spot(Base):
    """FT8/FT4/WSPR decoded spots from HF digital mode decoder."""
    __tablename__ = "spots"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, nullable=False, index=True)
    mode = Column(String(10), nullable=False, index=True)   # ft8, ft4, wspr
    dial_frequency_hz = Column(BigInteger, nullable=False, index=True)  # dial freq
    audio_offset_hz = Column(Integer, nullable=True)        # offset within passband
    snr_db = Column(Float, nullable=True)
    dt = Column(Float, nullable=True)                       # time delta
    callsign = Column(String(20), nullable=True, index=True)  # decoded callsign (TX)
    grid = Column(String(10), nullable=True)                # Maidenhead grid
    power_dbm = Column(Integer, nullable=True)              # TX power (WSPR)
    message = Column(String(255), nullable=True)            # raw decoded message
    band = Column(String(10), nullable=True)                # e.g. "20m", "40m"
    distance_km = Column(Float, nullable=True)              # calculated distance
    tx_latitude = Column(Float, nullable=True)              # from grid square
    tx_longitude = Column(Float, nullable=True)             # from grid square
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_spots_mode_ts", "mode", "timestamp"),
        Index("ix_spots_callsign_ts", "callsign", "timestamp"),
        Index("ix_spots_band", "band"),
    )
