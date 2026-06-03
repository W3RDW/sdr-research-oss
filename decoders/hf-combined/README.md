# Combined HF decoder (HFDL + SSTV-HF)

Time-shares a single RX888 (via SoapyRemote) between two HF modes that would
otherwise need their own SDR. The RX888 SoapyRemote server accepts only one
streaming client at a time, so the entrypoint alternates phases in a loop:

- **Phase 1 — HFDL** (`dumphfdl`): monitors HF Data Link ground-station
  channels for `HFDL_DWELL_SEC` (default 5 min) and writes decoded JSON frames
  to `HFDL_OUTPUT_DIR` (default `/data/text/hfdl`).
- **Phase 2 — SSTV-HF** (SoapySDR Python + `slowrx-cli`): cycles through HF
  SSTV calling frequencies, USB-demodulates the audio in NumPy/SciPy, and
  decodes images to `SSTV_OUTPUT_DIR` (default `/data/images/sstv`).

Between phases it pauses briefly so the SoapyRemote stream is fully released
before the next client connects. Both output paths are picked up automatically
by the API indexer.

## How it builds

None of the tools are in Debian/Ubuntu apt, so the `Dockerfile` builds all of
them from source on `ubuntu:22.04`:

- `libacars` — dependency of `dumphfdl` (cmake).
- `dumphfdl` — HFDL decoder, compiled with `-DSOAPYSDR=ON` so it can pull IQ
  from a [SoapyRemote](https://github.com/pothosware/SoapyRemote) server.
- `slowrx-cli` — headless SSTV image decoder (make).
- `ExtIO_sddc` — the RX888/SDDC SoapySDR driver, plus the RX888's FX3 firmware.

The FX3 firmware (`SDDC_FX3.img`) ships **committed in the ExtIO_sddc repo
root**; the build copies it from the checkout to
`/usr/local/share/sddc/SDDC_FX3.img`. There is no separate firmware download
URL — the only network dependency is the `git clone` of each source repo.

### Build

```sh
docker build -t sdr-research-hf-combined decoders/hf-combined
```

**amd64 only.** The SDDC/RX888 driver and its DSP carry x86_64-specific AVX
code paths, and the production deployment pins to an amd64 node; arm64 is not
supported.

## Runtime

This decoder talks to an RX888 exposed over SoapyRemote. Configuration is via
env vars:

| Env var               | Default                                                | Purpose                                                         |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `SOAPY_REMOTE`        | `rx888-soapy.sdr-research.svc.cluster.local:55132`     | SoapyRemote `host:port`                                        |
| `SOAPY_DEVICE_STRING` | _(empty)_                                              | Full Soapy device string; overrides `SOAPY_REMOTE` if set      |
| `HFDL_OUTPUT_DIR`     | `/data/text/hfdl`                                      | Where decoded HFDL JSON frames are written                     |
| `HFDL_FREQUENCIES`    | `8912 8927 10081 11384 13303`                          | Space-separated HFDL channels (kHz)                            |
| `HFDL_DWELL_SEC`      | `300`                                                  | Seconds spent in the HFDL phase per cycle                      |
| `SSTV_OUTPUT_DIR`     | `/data/images/sstv`                                    | Where decoded SSTV PNG images are written                      |
| `HF_SSTV_FREQS`       | `14230000,21340000,28680000,7171000`                   | Comma-separated HF SSTV frequencies (Hz)                       |
| `HF_SAMPLE_RATE`      | `2048000`                                              | IQ sample rate for SSTV capture (Hz)                           |
| `HF_AUDIO_RATE`       | `16000`                                                | Demodulated audio rate fed to `slowrx-cli` (Hz)               |
| `HF_DWELL_SEC`        | `120`                                                  | Seconds spent on each SSTV frequency                           |
| `HF_GAIN`             | `20`                                                   | SDR gain for SSTV capture                                      |
| `SDL_VIDEODRIVER`     | `offscreen` _(set by entrypoint)_                      | Forces `slowrx-cli` headless                                   |
| `SDL_AUDIODRIVER`     | `dummy` _(set by entrypoint)_                          | Forces `slowrx-cli` headless                                   |

## Hardware / runtime requirements

Unlike the VHF decoders (which only need a reachable SoapyRemote server), this
decoder owns the RX888:

- A **reachable RX888 SoapyRemote server** providing the IQ stream, or direct
  USB access to the RX888.
- **USB device access + privileged container** — the RX888's Cypress FX3 USB
  controller needs the FX3 firmware (`SDDC_FX3.img`) uploaded to it before it
  streams. In production the container runs `privileged: true` with
  `/dev/bus/usb` host-mounted.
- **Exclusive use of the RX888** — scale any other RX888 consumers to 0 while
  this decoder runs; the SoapyRemote server serves one streaming client at a
  time.
