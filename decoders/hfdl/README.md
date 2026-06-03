# HFDL decoder

Decodes HFDL (High Frequency Data Link) aviation messages from the HF
shortwave bands (~3–22 MHz) using [`dumphfdl`](https://github.com/szpajder/dumphfdl).
HFDL is a long-range datalink that aircraft use to exchange ACARS-style
position and status messages with ground stations over HF.

The decoder connects to an HF SDR (e.g. an RX888) exposed over SoapyRemote,
tunes a set of ground-station frequencies, and writes one JSON file per decoded
frame to `HFDL_OUTPUT_DIR`. The API indexer picks these up as `mode="hfdl"`
recordings.

## Build

Build context is this directory:

```sh
docker buildx build --platform linux/amd64 -t sdr-research-hfdl decoders/hfdl
```

`dumphfdl` and its dependency `libacars` are not in Debian/Ubuntu apt, so the
image builds both from source (`-DSOAPYSDR=ON`). The build is amd64-only in CI
— see "Architecture" below.

## Configuration

| Env var               | Default                                                  | Notes |
|-----------------------|----------------------------------------------------------|-------|
| `SOAPY_REMOTE`        | `rx888-soapy.sdr-research.svc.cluster.local:55132`       | `host:port` of the SoapyRemote server fronting the HF SDR. |
| `SOAPY_DEVICE_STRING` | `driver=SDDC`                                            | Soapy device string for the remote radio (set in the deployment env). |
| `HFDL_FREQUENCIES`    | `8912000 8927000 10081000 11384000 13303000`            | Space-separated ground-station frequencies. **dumphfdl expects kHz** — pass `8912 8927 10081 11384 13303`. The in-script default is in Hz and must be overridden with kHz values (the reference deployment does this). |
| `HFDL_OUTPUT_DIR`     | `/data/text/hfdl`                                        | Where per-frame JSON files are written. |

## Runtime requirements

- **HF SDR over SoapyRemote.** Needs an HF-capable SDR (RX888 / SDDC) reachable
  at `SOAPY_REMOTE`. The remote SoapyRemote server is not part of this image.
- **Single-consumer radio.** The RX888 SoapyRemote server accepts only one
  client at a time. Stop any other consumer of that radio (e.g. a waterfall /
  OpenWebRX) before running this decoder, or use a dedicated HF SDR.
- **Shared artifacts volume.** Mount the shared `/data` PVC so the API indexer
  can read `HFDL_OUTPUT_DIR`.
- **Node pinning.** In the reference cluster the RX888 is attached to a specific
  node; pin the decoder there with a `nodeSelector` if you do direct USB access.

## Architecture

amd64-only in CI. `dumphfdl` and `libacars` compile cleanly on arm64, but the
RX888/SoapyRemote path is only exercised on amd64, so the GHCR build matrix
publishes `linux/amd64` for this image. Add `linux/arm64` to the matrix entry
only after validating an arm64 build.
