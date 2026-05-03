# Architecture

```
┌─────────────────┐
│  Your SDR       │  USB or SoapyRemote
└────────┬────────┘
         │ IQ samples
         ▼
┌─────────────────┐    energy-detected     ┌──────────────┐
│  unified-sdr    │ ─── FM/CW/APRS ─────► │ /data/audio/ │
│  (GNURadio)     │      WAVs              │   *.wav      │
└─────────────────┘                        └──────┬───────┘
                                                  │
        ┌────────────────────┬───────────────────┴──────────────┐
        ▼                    ▼                                   ▼
┌──────────────┐    ┌────────────────┐                ┌──────────────────┐
│ aprs-decoder │    │  cw-decoder    │                │  voice-decoder   │
│ (multimon-ng)│    │  (custom)      │                │  (Whisper STT)   │
└──────┬───────┘    └────────┬───────┘                └─────────┬────────┘
       │                     │                                  │
       ▼                     ▼                                  ▼
  /data/text/aprs/     /data/text/cw/                       (transcripts
       │                     │                              persisted via
       └─────────────┬───────┘                              indexer below)
                     ▼
            ┌──────────────────┐
            │  api  (FastAPI)  │
            │  ─ indexer scans │
            │    /data, upserts│
            │    Recording rows│
            │  ─ Whisper sidecar
            │  ─ Ollama tagger │
            │  ─ RepeaterBook  │
            │    sync nightly  │
            │  ─ alert webhook │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐         ┌──────────────────┐
            │   PostgreSQL     │         │  ui (React)      │
            │   recordings,    │ ◄────── │  /search /aprs   │
            │   spots,         │  REST   │  /spots /map     │
            │   repeaters,     │         │  /admin          │
            │   alert_history  │         └──────────────────┘
            └──────────────────┘
```

## Data flow

1. `unified-sdr` reads IQ samples from the SDR, runs an FFT-based energy
   detector, and assigns active peaks to one of N pre-wired demodulator slots
   (FM / CW / APRS).
2. Each slot writes a WAV file to `/data/audio/<voice|cw|aprs>/` when its
   squelch opens, and closes the file when squelch closes (with a tail).
3. Decoder containers watch `/data/audio/` for new WAVs in their band of
   interest, decode them, and write text/JSON output to `/data/text/<type>/`.
4. The `api` indexer continuously scans `/data` for new files, upserts
   `Recording` rows, transcribes voice clips (Whisper sidecar), tags them
   (Ollama, optional), and matches frequencies to known repeaters.
5. The `ui` queries the API for searchable lists, audio playback URLs,
   waveform JSONs, APRS positions, FT8/WSPR spots, etc.

## Why this architecture

### Pre-wired slot architecture in the GNURadio flowgraph

Adding/removing demodulators on a running flowgraph (`tb.connect()` /
`tb.disconnect()`) causes heap corruption / SIGSEGV in GNURadio 3.10. The
fix: pre-wire all dynamic slots at init time with inhibited squelch, and
"activate" or "deactivate" by toggling parameters only — no graph mutation
after `tb.start()`.

### Energy detector + per-slot squelch

The FFT detector runs every `FFT_INTERVAL` seconds, finds peaks above
`ENERGY_THRESH_DB`, and assigns them to free demodulator slots. Each slot has
its own squelch, so quiet channels don't waste recording space.

### Decoders as separate containers

Each decoder is a single-purpose container. They share a PVC with the SDR
output, scan for new files, and write their results to a sibling text dir.
This keeps the API stateless and makes it easy to enable/disable individual
decoders without touching the main pipeline.

### Indexer-on-PVC instead of message queue

The indexer is just a polling scan of `/data`. No Kafka, no Redis, no
SQS. For a single-node home installation this is fine; for higher throughput
you'd want notify-based file watching or a real queue.

## Schema (key tables)

| Table | Purpose |
|---|---|
| `recordings` | One row per WAV / text artifact: timestamp, frequency, mode, audio path, transcript, repeater_id, ai_tags |
| `repeaters` | RepeaterBook cache: callsign, frequency_hz, input_hz, pl_tone, location, modes |
| `spots` | FT8/WSPR decode events: callsign, grid, snr, drift |
| `alert_history` | Webhook trigger log |
| `callsign_info` | HamDB cache for licensee names + grids |
| `frequency_labels` | User-overridable labels for known frequencies |

See `api/app/models.py` for the SQLAlchemy definitions.

## Performance notes

- One `unified-sdr` container at 6 MS/s uses ~2 CPU cores for the FFT
  detector + 12 demodulator slots.
- Whisper `base.en` on CPU runs ~real-time; `medium.en` needs GPU.
- The indexer scan is O(N) on file count; for archives over ~100k files
  consider switching to inotify (PR welcome).
- Postgres can stay tiny — recordings table is the only one that grows
  fast (few hundred MB/year per SDR).
