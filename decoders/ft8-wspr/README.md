# Unified HF decoder (FT8/WSPR + HFDL + SSTV)

A single image that time-shares one RX888 across four HF workloads. The
container connects to the RX888 over SoapyRemote (driver `SDDC`), captures
I/Q, decimates to audio in software, and rotates between modes:

| Mode    | Tool                         | Output                                  |
|---------|------------------------------|-----------------------------------------|
| FT8/FT4 | `jt9 --ft8` (WSJT-X)         | spot JSON → `FT8_OUTPUT_DIR`            |
| WSPR    | `wsprd` (WSJT-X)             | spot JSON → `FT8_OUTPUT_DIR`            |
| HFDL    | `dumphfdl` (built from src)  | frame JSON → `HFDL_OUTPUT_DIR`         |
| SSTV    | I/Q capture → WAV            | WAV → `SSTV_OUTPUT_DIR` (decoded later) |

The `api` indexer picks up the JSON files and inserts them into the `spots`
table. SSTV WAVs are written for a separate `sstv` decoder to process.

## Single-client constraint (important)

The RX888 SoapyRemote server serves **one client at a time**. This decoder
must be the sole consumer of the radio while running. If you also run
OpenWebRX (or any other SDR workload) against the same RX888, scale it to 0
first:

```sh
kubectl scale deploy openwebrx -n sdr-research --replicas=0
kubectl scale deploy ft8-wspr-decoder -n sdr-research --replicas=1
```

Because of this, the decoder pins to the node with the RX888 attached
(`nodeSelector`) and runs a single replica with `strategy: Recreate`.

## Time-sharing scheduler

Each non-FT8 mode runs once every *N* FT8 cycles, tracked with **independent
per-mode counters** so no mode starves another:

- `WSPR_EVERY_N` (default 6) — one WSPR window per N cycles
- `SSTV_EVERY_N` (default 7) — one SSTV capture per N cycles
- `HFDL_EVERY_N` (default 11) — one HFDL dwell per N cycles

Priority is WSPR > SSTV > HFDL > FT8. Keep the three `*_EVERY_N` values
pairwise coprime (6, 7, 11) so collisions only delay a mode by one cycle
instead of permanently preempting it. WSPR captures wait for the 2-minute UTC
boundary; FT8 aligns to the 15-second boundary.

## Capture path

The RX888 MkII (SDDC ADC) only supports 2/4/8/16/32/64 MSPS. The decoder
captures at `CAPTURE_SAMPLE_RATE` (default 2 MSPS), mixes down by 1500 Hz, and
decimates in two scipy stages to 12 kHz mono WAV — the rate `jt9`/`wsprd`
expect. It prefers the Python `SoapySDR` bindings and falls back to the
`rx_sdr` CLI (`rx_tools`) when bindings are unavailable
(`FT8_CAPTURE_BACKEND=rx_sdr` forces the CLI path).

## Environment variables

See the deployment / Helm values for the full list. Key ones:

- `SOAPY_REMOTE` — `host:port` of the RX888 SoapyRemote server
- `SOAPY_DEVICE_STRING` — override the full Soapy device string (e.g. `driver=SDDC`)
- `SOAPY_GAIN` — RX gain (dB)
- `FT8_FREQUENCIES`, `WSPR_FREQUENCIES`, `SSTV_FREQUENCIES` — space-separated Hz
- `HFDL_FREQUENCIES` — space-separated **kHz** (`dumphfdl` expects kHz)
- `HFDL_ENABLED`, `HFDL_CENTERFREQ`, `HFDL_SAMPLE_RATE` — HFDL window config
- `FT8_OUTPUT_DIR`, `HFDL_OUTPUT_DIR`, `SSTV_OUTPUT_DIR` — output paths
- `STATION_GRID` — Maidenhead grid for great-circle distance

> SSTV WAVs must **not** land in `/data/audio/voice` (the API's no-speech
> cleanup deletes short voice WAVs within seconds). Use a private path such as
> `/data/audio/sstv`.

## Runtime requirements

- `privileged: true` and `/dev/bus/usb` mounted (USB access to the radio).
- The SoapySDDC plugin (`libSDDCSupport.so`) on `SOAPY_SDR_PLUGIN_PATH` — in
  the cluster an init container copies it from the RX888 server image into a
  shared volume mounted at `/opt/soapy-modules`.
- Shared `/data` artifacts volume (ReadWriteMany) so the `api` indexer and the
  `sstv` decoder can read the outputs.

## Build

```sh
docker buildx build --platform linux/amd64 -t sdr-research-ft8-wspr .
```

amd64 is the supported target. arm64 is **not** recommended: the build pulls
`wsjtx` from Debian and source-builds `rx_tools` and `dumphfdl`, which has only
been exercised on amd64. See the build matrix note in `.github/workflows/build.yml`.
