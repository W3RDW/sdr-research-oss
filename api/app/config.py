from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://sdr_viewer:password@localhost:5432/sdr_viewer"
    audio_base_path: str = "/data/audio"
    text_base_path: str = "/data/text"
    cache_path: str = "/cache"
    auto_delete_no_speech: bool = False
    ollama_enabled: bool = False
    ollama_url: str = "http://ollama:11434"
    ollama_model: str = "llama3.1:8b"
    ollama_timeout_seconds: float = 20.0
    ollama_max_tags: int = 8
    ollama_max_per_cycle: int = 40

    # Station identity (spots comparison, satellite passes, APRS-IS overlay)
    station_callsign: str = "N0CALL"
    station_grid: str = ""               # Maidenhead locator, e.g. EM79
    station_lat: float = 0.0             # 0 = fall back to repeaterbook_latitude
    station_lon: float = 0.0             # 0 = fall back to repeaterbook_longitude

    # Satellite recording windows (written for unified-sdr to arm recorders)
    sat_windows_enabled: bool = True
    sat_record_min_elevation: float = 15.0

    # PSKReporter comparison ("antenna vs world")
    pskreporter_enabled: bool = True
    pskreporter_poll_seconds: int = 600  # be polite: one sampled query per cycle

    # HamDB callsign lookup
    hamdb_enabled: bool = True
    hamdb_cache_days: int = 30
    hamdb_max_per_cycle: int = 10

    # RepeaterBook sync
    repeaterbook_enabled: bool = False
    repeaterbook_email: str = ""
    repeaterbook_latitude: float = 0.0
    repeaterbook_longitude: float = 0.0
    repeaterbook_radius_miles: int = 75
    repeaterbook_states: str = ""
    repeaterbook_sync_hours: int = 24

    # Alerting
    alert_webhook_url: str = ""          # POST target; empty = disabled
    alert_keywords: str = ""             # comma-separated transcript keywords
    alert_callsigns: str = ""            # comma-separated callsigns to watch

    # Retention
    retention_days: int = 0             # 0 = disabled; auto-delete recordings older than N days

    class Config:
        env_file = ".env"


settings = Settings()
