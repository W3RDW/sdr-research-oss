# Configuration reference

All configuration is via environment variables. Defaults shown after `=`.
See [`.env.example`](../.env.example) for a copy-paste-ready template.

## Station identity

| Var | Default | Notes |
|---|---|---|
| `STATION_CALLSIGN` | `N0CALL` | Your callsign. Logbook + alert filter. |
| `STATION_GRID` | `AA00aa` | Maidenhead grid. Used in spot stats. |
| `STATION_LAT` / `STATION_LON` | `0.0` | Distance calcs (Haversine). |
| `OPERATOR_EMAIL` | `operator@example.com` | Default User-Agent contact. |

## Database

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | required | `postgresql://user:pass@host:5432/db` |

The API auto-creates tables on first start. No Alembic yet; schema changes
need a manual `ALTER TABLE`.

## SDR capture

| Var | Default | Notes |
|---|---|---|
| `OSMOSDR_ARGS` | `rtl_tcp=rtl-tcp:1234` | See [hardware-matrix.md](hardware-matrix.md). |
| `CAPTURE_ID` | `default` | Free-form label. Used in artifact filenames. |
| `SAMPLE_RATE` | `2400000` | Hz. RTL=2.4M, Airspy=3M or 6M, RX888=64M. |
| `DWELL_CENTER_HZ` | `146000000` | Hz. Center of capture band. |
| `FIXED_MONITOR_HZ` | `146520000` | Hz. Always-on demodulator (e.g. APRS). |
| `SCAN_CENTERS` | `[]` | JSON list. e.g. `[153000000, 162500000]`. Empty = no scanning. |
| `DWELL_SEC` | `60` | Seconds on primary band before scanning. |
| `SCAN_SEC` | `5` | Seconds per scan center. |
| `RF_GAIN` | `40` | Tuner gain. RTL=0–49 dB, Airspy=0–21 (index). |
| `PPM_CORRECTION` | `0` | Frequency correction. Tune per device. |

## Detector / squelch

| Var | Default | Notes |
|---|---|---|
| `RF_SQUELCH_DB` | `-50` | RF squelch threshold (dBFS). With `AUTO_SQUELCH` (default) this is only the initial value until the first floor measurement. |
| `AUTO_SQUELCH` | `1` | Track each FM channel's noise floor and hold the RF squelch `AUTO_SQUELCH_MARGIN_DB` above it. Static thresholds fail in both directions when the floor moves (gain/hardware/band changes): below the floor records noise 24/7, above real traffic records nothing. Logs `[SQL] <freq> lvl/floor/thr` lines for tuning. `0` = static threshold. |
| `AUTO_SQUELCH_MARGIN_DB` | `6` | Squelch margin above the measured per-channel floor. |
| `AUTO_SQUELCH_RISE_DB` | `0.1` | Max floor rise per interval while idle (dB); floor follows drops immediately and never rises during a recording. |
| `AUTO_SQUELCH_MIN_DB` / `AUTO_SQUELCH_MAX_DB` | `-70` / `-25` | Clamp bounds for the derived threshold. |
| `NOISE_DISCARD_RMS_DB` | `-9` | Discard any FM/AM recording whose audio RMS **over active (non-squelch-gated) samples** is at or above this. Demodulated FM noise bursts measure ~-7 dB active; real voice ~-15 dB. `100` disables. |
| `SQUELCH_OPEN_DB` | `-50` | Audio squelch open threshold. |
| `SQUELCH_CLOSE_DB` | `-55` | Audio squelch close threshold (hysteresis). |
| `ENERGY_THRESH_DB` | `10` | FFT peak detection above noise floor. **Don't raise above 10** — breaks FM. |
| `FM_RECORD_BANDS_HZ` | `144300000-148000000,150000000-162000000,222000000-225000000,433000000-450000000` | Comma-separated ranges routed to FM/pager voice recorders. FM bands are preferred over the bandwidth heuristic so quiet repeaters are not filed as CW. |
| `CW_RECORD_BANDS_HZ` | `144000000-144150000,432000000-432100000` | Comma-separated ranges eligible for dynamic CW recording. Set to empty or `NUM_DYN_CW=0` if you do not want CW captures. |
| `MIN_REC_SEC` | `0.5` | Discard recordings shorter than this. |
| `MAX_REC_SEC` | `120` | Force-close recordings longer than this. |
| `TAIL_SEC` | `1.5` | Keep recording for N sec after squelch closes. |
| `NUM_DYN_FM` | `8` | Dynamic FM demodulator slots. |
| `NUM_DYN_CW` | `4` | Dynamic CW slots. |
| `NUM_DYN_ACARS` | `0` | Dynamic AM (ACARS) slots. |
| `DYN_SLOT_FREQ_TOLERANCE_HZ` | `2500` | Existing dynamic slot refresh tolerance. Prevents one drifting FFT peak from consuming multiple slots. |
| `SLOT_RECYCLE_SEC` | `300` | Free unused slots after this. |
| `NOISE_GUARD_ROLLOVERS` | `3` | Deactivate + blocklist a channel after this many consecutive `MAX_REC_SEC` rollovers (spur/birdie signature — real traffic has squelch drops between overs). `0` disables. |
| `NOISE_GUARD_COOLDOWN_SEC` | `1800` | How long a noise-guarded frequency stays blocklisted. |
| `FFT_SIZE` | `4096` | FFT bins. Higher = finer resolution, more CPU. |
| `FFT_INTERVAL` | `1.0` | Seconds between detector runs. |

## API

| Var | Default | Notes |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:5173` | Comma-separated. |
| `CACHE_PATH` | `/tmp/sdr-viewer-cache` | Waveform / spectrogram cache dir. |
| `TEXT_BASE_PATH` | `/data/text` | Where decoders write text artifacts. |
| `HF_TEXT_BASE_PATH` | `/data/hf/text` | Same, for HF decoders (separate volume). |

## RepeaterBook

| Var | Default | Notes |
|---|---|---|
| `REPEATERBOOK_ENABLED` | `false` | Enable nightly repeater sync + per-recording lookup. |
| `REPEATERBOOK_API_KEY` | empty | Get a token at <https://www.repeaterbook.com/api/token_request.php>. |
| `REPEATERBOOK_USER_AGENT` | `sdr-research-oss/1.0 (operator@example.com)` | **Must match** the value approved with your token. |
| `REPEATERBOOK_EMAIL` | `operator@example.com` | Reported in API calls. |
| `REPEATERBOOK_LATITUDE` / `_LONGITUDE` | station coords | Center of repeater radius search. |
| `REPEATERBOOK_RADIUS_MILES` | `75` | |
| `REPEATERBOOK_STATES` | empty | Comma-separated, e.g. `OH,IN,KY`. |
| `REPEATERBOOK_SYNC_HOURS` | `24` | Re-sync interval. |

## Alerts

| Var | Default | Notes |
|---|---|---|
| `ALERT_CALLSIGNS` | empty | Comma-separated. POST webhook on transcript match. |
| `ALERT_KEYWORDS` | empty | Comma-separated. Same. |
| `ALERT_WEBHOOK_URL` | empty | POST destination. Slack/Discord/Webhook.site/etc. |

## Whisper transcription

| Var | Default | Notes |
|---|---|---|
| `WHISPER_ENABLED` | `false` | |
| `WHISPER_MODEL` | `base.en` | `tiny`, `base`, `small`, `medium`, `large-v3` |
| `WHISPER_DEVICE` | `cpu` | `cuda` for GPU. Needs nvidia-container-toolkit. |

## Ollama tagging

Auto-tags voice transcripts with topic / intent / sentiment hints. See the
[setup walkthrough](ollama-setup.md) for getting Ollama running alongside
the stack.

| Var | Default | Notes |
|---|---|---|
| `OLLAMA_ENABLED` | `false` | Master switch. |
| `OLLAMA_URL` | `http://ollama:11434` | Base URL of your Ollama server. |
| `OLLAMA_MODEL` | `llama3.1:8b` | Any model the server has pulled. Smaller = faster. |
| `OLLAMA_TIMEOUT_SECONDS` | `20` | Per-request timeout. Raise on CPU. |
| `OLLAMA_MAX_TAGS` | `8` | Cap on tags per recording. |
| `OLLAMA_MAX_PER_CYCLE` | `40` | Cap on Ollama calls per indexer pass. |

The indexer has a circuit breaker: 3 consecutive failures opens it for 5
minutes. Failures + call counts are exposed as Prometheus metrics
(`indexer_ollama_calls`, `indexer_ollama_errors`).

## APRS-IS upstream

| Var | Default | Notes |
|---|---|---|
| `APRS_IS_ENABLED` | `false` | Outbound publish to APRS-IS. |
| `APRS_IS_CALLSIGN` | empty | Your callsign. |
| `APRS_IS_PASSCODE` | empty | APRS-IS passcode (not your password). Generate via `aprspass`. |
| `APRS_IS_FILTER` | `r/0/0/100` | Filter spec. See APRS-IS docs. |
