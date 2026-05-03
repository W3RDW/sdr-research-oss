from prometheus_client import Counter, Gauge, Histogram

# Indexer activity counters
indexer_files_indexed = Counter(
    'sdr_indexer_files_indexed_total',
    'Files indexed by the background indexer',
    ['mode'],
)
indexer_files_deleted = Counter(
    'sdr_indexer_files_deleted_total',
    'Recordings auto-deleted during indexing',
    ['reason'],
)
indexer_cycle_duration = Histogram(
    'sdr_indexer_cycle_duration_seconds',
    'Duration of a full indexer cycle in seconds',
    buckets=[1, 2, 5, 10, 20, 30, 60, 120],
)
indexer_last_run = Gauge(
    'sdr_indexer_last_run_timestamp_seconds',
    'Unix timestamp of last completed indexer cycle',
)
indexer_ollama_calls = Counter(
    'sdr_indexer_ollama_calls_total',
    'Ollama API calls made by the indexer',
)
indexer_ollama_errors = Counter(
    'sdr_indexer_ollama_errors_total',
    'Ollama API call failures',
)
aprs_packets_indexed = Counter(
    'sdr_aprs_packets_indexed_total',
    'APRS packets indexed from text files',
)
alerts_fired = Counter(
    'sdr_alerts_fired_total',
    'Webhook alerts fired for matched recordings',
)

# DB-level gauges — refreshed once per indexer cycle
recordings_total = Gauge(
    'sdr_recordings_total',
    'Total recordings in the database',
    ['mode'],
)
recordings_with_transcript = Gauge(
    'sdr_recordings_with_transcript_total',
    'Recordings that have a transcript',
)
recordings_with_ai_tags = Gauge(
    'sdr_recordings_with_ai_tags_total',
    'Recordings that have AI tags',
)
recordings_with_repeater = Gauge(
    'sdr_recordings_with_repeater_total',
    'Recordings matched to a known repeater',
)
recordings_pending_transcript = Gauge(
    'sdr_recordings_pending_transcript_total',
    'Voice/CW recordings awaiting transcription',
)
recordings_pending_ai_tags = Gauge(
    'sdr_recordings_pending_ai_tags_total',
    'Transcribed recordings awaiting AI tagging',
)
recordings_pending_freq_label = Gauge(
    'sdr_recordings_pending_freq_label_total',
    'Recordings with a frequency but no label',
)
repeater_count = Gauge(
    'sdr_repeater_count_total',
    'Total repeaters in the local database',
)
repeater_sync_age_seconds = Gauge(
    'sdr_repeater_sync_age_seconds',
    'Seconds since the last successful repeater sync',
)
sdr_hardware_last_seen_seconds = Gauge(
    'sdr_hardware_last_seen_seconds',
    'Seconds since the most recent audio file from SDR hardware',
)
sdr_hardware_last_seen = Gauge(
    'sdr_hardware_last_seen_per_band_seconds',
    'Seconds since last recording from SDR hardware, per band and source',
    ['band', 'source_sdr'],
)
spots_indexed = Counter(
    'sdr_spots_indexed_total',
    'FT8/WSPR spots indexed',
    ['mode'],
)
spots_total = Gauge(
    'sdr_spots_total',
    'Total spots in the database',
    ['mode'],
)
aprs_is_packets_indexed = Counter(
    'sdr_aprs_is_packets_indexed_total',
    'APRS-IS packets ingested from the internet',
)
aprs_is_connected = Gauge(
    'sdr_aprs_is_connected',
    'Whether the APRS-IS client is currently connected (1=yes, 0=no)',
)
