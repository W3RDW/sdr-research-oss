# sdr-research-oss

Software-defined radio capture, decode, transcribe, and search — for amateur
radio operators, signal hunters, and people who want to know what's on the air.

Plug in an RTL-SDR (or Airspy, or RX888), point it at a band, and get:

- **Continuous recording** — energy-detected FM/AM voice + CW + APRS bursts written as WAVs
- **Whisper transcription** of every voice clip (optional, GPU-accelerated)
- **AI tagging** of transcripts via local Ollama (optional)
- **APRS map** with great-circle paths from packet decoder
- **FT8 / WSPR spot logging** with worldwide map
- **RepeaterBook integration** — every recording matched to its repeater
- **Searchable web UI** (React) with audio playback, waveform/spectrogram, callsign lookup
- **Alerts** — webhook on configurable callsign/keyword matches

> Status: extracted from a private production deployment. Functional but rough
> around the edges. PRs and issues welcome.

---

## Quickstart (Docker Compose)

```bash
git clone https://github.com/w3rdw/sdr-research-oss
cd sdr-research-oss
cp .env.example .env
# Edit .env: STATION_CALLSIGN, OSMOSDR_ARGS, station coords
cd deploy/docker-compose
docker compose up -d
```

Then open http://localhost:8080.

For Kubernetes, see [`deploy/helm/`](deploy/helm/) or [`deploy/kustomize/`](deploy/kustomize/).

---

## What's in the box

```
sdr-research-oss/
├── api/                    FastAPI backend — indexer, search, RepeaterBook, alerts
├── ui/                     React/Vite SPA — recordings browser, APRS map, spots map
├── decoders/               Containerized signal decoders
│   ├── unified-sdr/        GNURadio flowgraph: energy detector → FM/CW/APRS slots
│   ├── aprs/  cw/          multimon-ng wrappers
│   ├── voice/              Whisper STT (CPU or GPU)
│   ├── pager/  eas/        POCSAG, SAME alert decoders
│   ├── acars/  vdl2/       Aircraft data link decoders
│   ├── sstv/               Slow-scan TV image decoder
│   ├── ft8-wspr/           Weak-signal HF spot decoder
│   └── spectrum-exporter/  Prometheus metrics from FFT
├── docker/                 Local-build helpers
├── deploy/
│   ├── docker-compose/     Single-host stack
│   ├── helm/sdr-research/  Helm chart for k8s
│   └── kustomize/          Plain manifests + overlay example
└── docs/                   Per-SDR setup, architecture, configuration
```

---

## Hardware support

| SDR | Driver | Notes |
|---|---|---|
| RTL-SDR | `rtl=N` or `rtl_tcp=host:port` | Cheapest path. 2.4 MS/s. |
| Airspy Mini / R2 | `airspy=N` | 6 MS/s, full 2m band in one capture. |
| Airspy HF+ | `airspyhf=N` | HF + 6m. |
| HackRF One | `hackrf=N` | TX-capable; 20 MS/s. |
| RX888 MkII | `driver=SDDC` | Direct sampling 0–64 MHz HF. Needs SoapySDDC driver built from source. |
| SoapyRemote | `soapy=0,driver=remote,remote=tcp://host:55132,remote:driver=DRIVER` | Run any of the above on a remote host. |

See [`docs/hardware-matrix.md`](docs/hardware-matrix.md) for full setup per device.

---

## Configuration

Everything is environment-variable-driven. Defaults are in [`.env.example`](.env.example).
Notable knobs:

| Var | What | Default |
|---|---|---|
| `OSMOSDR_ARGS` | SDR device string | `rtl_tcp=rtl-tcp:1234` |
| `DWELL_CENTER_HZ` | Center frequency to monitor | `146000000` (2m) |
| `SAMPLE_RATE` | SDR sample rate | `2400000` |
| `RF_SQUELCH_DB` | Squelch threshold (dBFS) | `-50` |
| `STATION_CALLSIGN` | Your callsign | `N0CALL` |
| `STATION_LAT` / `STATION_LON` | Coords for distance calcs / APRS map | `0.0` / `0.0` |
| `WHISPER_ENABLED` | Voice transcription on/off | `false` |
| `REPEATERBOOK_ENABLED` | Auto-match recordings to repeaters | `false` |
| `OLLAMA_ENABLED` | AI tagging via local LLM | `false` |

See [`docs/configuration.md`](docs/configuration.md) for the full list.

---

## Optional integrations

- **[RepeaterBook](https://www.repeaterbook.com/api/token_request.php)** — request an API key, set `REPEATERBOOK_API_KEY`, `REPEATERBOOK_USER_AGENT` (must match the approved value), and `REPEATERBOOK_STATES` (comma-separated state codes to sync, e.g. `OH,IN,KY`). The API will sync repeaters in your radius nightly and label matching recordings. Full walkthrough: [`docs/repeaterbook-setup.md`](docs/repeaterbook-setup.md).
- **[Whisper](https://github.com/openai/whisper)** — CPU works, GPU is ~50× faster. Set `WHISPER_DEVICE=cuda` if you have nvidia-container-toolkit installed.
- **[Ollama](https://ollama.com/)** — runs locally; the API will POST transcripts and tag them with topic/intent/sentiment hints.
- **APRS-IS** — outbound publishing of decoded packets to the APRS-IS network. Set `APRS_IS_CALLSIGN` + `APRS_IS_PASSCODE`.

---

## Development

```bash
# API (Python)
cd api
pip install -e .
uvicorn app.main:app --reload

# UI (React)
cd ui
npm install
npm run dev
```

DB needs a running Postgres. Easiest: `docker compose up postgres` from `deploy/docker-compose/`.

---

## Building images yourself

```bash
docker buildx build --platform linux/amd64 -t my-registry/sdr-research-api:dev api/
docker buildx build --platform linux/amd64 -t my-registry/sdr-research-ui:dev ui/
docker buildx build --platform linux/amd64 -t my-registry/sdr-research-unified-sdr:dev decoders/unified-sdr/
```

For multi-arch (push to a registry that supports it):
```bash
docker buildx build --platform linux/amd64,linux/arm64 --push -t my-registry/sdr-research-api:dev api/
```

CI builds + pushes to `ghcr.io/<owner>/sdr-research-{api,ui,unified-sdr,...}` on push to `main` and on tag.

---

## Security / secrets

- Never commit `.env`, secrets, or API keys. The `.gitignore` already excludes
  `.env*`, `*.sops.yaml`, `*.age`, `age.key`.
- The Helm chart auto-generates a Postgres password on install. To rotate, set
  `existingSecret`.
- For external secret managers (1Password, Vault, etc.), use `existingSecret`
  in Helm or your secret-injection pattern of choice in Kustomize.
- See [`docs/security.md`](docs/security.md).

---

## Status / roadmap

This is freshly extracted from a private deployment. Known gaps:

- [ ] Decoder Helm sub-templates (only the unified-sdr is wired in)
- [ ] FT8/WSPR decoder script (interface documented; implementation TBD)
- [ ] Database migrations (currently auto-creates tables; no Alembic yet)
- [ ] CI is configured but unverified end-to-end

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## License

[MIT](LICENSE).
