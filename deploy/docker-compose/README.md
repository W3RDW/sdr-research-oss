# Docker Compose deployment

Single-host stack for testing or small/home installations.

## Quickstart

```bash
cd deploy/docker-compose
cp ../../.env.example .env
$EDITOR .env                    # set STATION_*, OSMOSDR_ARGS, secrets
docker compose up -d
```

UI: http://localhost:8080  
API: http://localhost:8000/api/v1/health  
Database: postgres://localhost:5432 (not exposed by default — uncomment ports if needed)

## Common SDR setups

### RTL-SDR (USB dongle)

```dotenv
OSMOSDR_ARGS=rtl=0
SAMPLE_RATE=2400000
DWELL_CENTER_HZ=146000000   # 2m band
RF_GAIN=40
```

The container needs USB access. Compose already passes `/dev/bus/usb` and runs
the SDR container privileged. If you have multiple RTL-SDRs, distinguish by
serial: `OSMOSDR_ARGS=rtl=00000001`.

### Airspy Mini / R2

```dotenv
OSMOSDR_ARGS=airspy=0
SAMPLE_RATE=6000000           # or 3000000
DWELL_CENTER_HZ=146000000
RF_GAIN=18                    # gain *index* 0–21, not dB
```

### Remote SDR via SoapyRemote

If your SDR lives on another host (e.g. a Raspberry Pi acting as a remote),
run `SoapySDRServer` over there and point the compose stack at it:

```dotenv
OSMOSDR_ARGS=soapy=0,driver=remote,remote=tcp://192.168.1.42:55132,remote:driver=airspy
```

## Adding decoders

Each decoder is a separate service. Uncomment the relevant block in
`docker-compose.yml`. All decoders share the `sdr-artifacts` volume so they
can read WAVs written by `unified-sdr` and write text/spot output that the
API indexer picks up automatically.

## Pulling prebuilt images instead of building

Set image tags in `.env`:

```dotenv
API_IMAGE=ghcr.io/w3rdw/sdr-research-api:v0.1.0
UI_IMAGE=ghcr.io/w3rdw/sdr-research-ui:v0.1.0
UNIFIED_SDR_IMAGE=ghcr.io/w3rdw/sdr-research-unified-sdr:v0.1.0
```

Then `docker compose pull && docker compose up -d`.

## Stopping / data

- `docker compose down` — stop containers, keep volumes
- `docker compose down -v` — stop and **delete all data** (recordings, DB)
- Volumes live under Docker's data root (`docker volume inspect <name>`)

## Troubleshooting

- **No recordings appearing** — check `docker compose logs unified-sdr`. Most
  common: SDR not detected (wrong `OSMOSDR_ARGS`), squelch too high
  (`RF_SQUELCH_DB`), or no signal in the captured band.
- **Database errors on first start** — give postgres a few seconds; the API
  has a healthcheck-gated start but migrations can race on cold start. Just
  `docker compose restart api`.
- **USB permission denied** — the `unified-sdr` container runs `privileged:
  true`, which should always work on Linux. On macOS you need a Linux VM
  with USB passthrough (Docker Desktop alone won't expose USB devices).
