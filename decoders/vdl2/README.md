# VDL Mode 2 decoder

Decodes VHF Data Link Mode 2 (digital aviation data link replacing/augmenting
ACARS), running around 136 MHz.

## How it builds

`dumpvdl2` and its `libacars` dependency are not packaged in Debian/Ubuntu
apt, so the `Dockerfile` builds both from source with cmake on `ubuntu:22.04`.
dumpvdl2 is compiled with `-DSOAPYSDR=ON` so it can pull IQ from a
[SoapyRemote](https://github.com/pothosware/SoapyRemote) server.

## Runtime

The entrypoint is `vdl2-entrypoint.py`. It runs `dumpvdl2` against a remote
SoapySDR server (an Airspy exposed over SoapyRemote), monitors the primary VDL2
channels, and writes one JSON file per decoded frame into `VDL2_OUTPUT_DIR` so
the API indexer can pick them up as `mode='vdl2'` recordings.

Environment variables:

| Var | Default | Notes |
|-----|---------|-------|
| `SOAPY_REMOTE` | `airspy-soapy.sdr-research.svc.cluster.local:55132` | host:port of the SoapyRemote server |
| `VDL2_OUTPUT_DIR` | `/data/text/vdl2` | per-frame JSON output dir |
| `VDL2_FREQUENCIES` | `136725000 136775000 136800000 136875000 136975000` | space-separated channel list, Hz |
| `VDL2_GAIN` | `18` | LNA gain element passed as `LNA=<gain>` |

This decoder needs a reachable SoapyRemote server providing the IQ stream; it
does not own an SDR device itself.

## Superseded files

`rtl_tcp_client.py` and `run_vdl2.sh` are an earlier rtl_tcp-based approach and
are no longer used by the image. The production build uses the SoapyRemote
entrypoint above. They are kept for reference only.
