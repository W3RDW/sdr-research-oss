# ACARS decoder

Decodes ACARS (Aircraft Communications Addressing and Reporting System)
messages from the VHF aviation airband (~129–132 MHz).

## Status: builds

The `Dockerfile` builds `libacars` and `acarsdec` from source (neither is
packaged in Debian/Ubuntu apt), then runs `acars-entrypoint.py`. The entrypoint
launches `acarsdec` against an Airspy over SoapyRemote (`-L driver=remote,…`),
parses its JSON output (`-j`), and writes one JSON file per decoded message to
`ACARS_OUTPUT_DIR` (default `/data/text/acars`), where the api indexer picks
them up as `mode='acars'` recordings.

### Build

```sh
docker build -t sdr-research-acars decoders/acars
```

The source build (cmake) is slow but reliable. The first two RUN layers clone
and compile `libacars` then `acarsdec`; both depend on `librtlsdr`,
`libsoapysdr`, `libjansson`, and `libxml2`.

### Runtime

This decoder connects to an Airspy exposed via SoapyRemote rather than reading
recorded WAV files. Configuration is via env vars:

| Env var             | Default                                                   | Purpose                              |
| ------------------- | --------------------------------------------------------- | ------------------------------------ |
| `SOAPY_REMOTE`      | `airspy-soapy.sdr-research.svc.cluster.local:55132`       | SoapyRemote `host:port`              |
| `ACARS_OUTPUT_DIR`  | `/data/text/acars`                                        | Where decoded JSON files are written |
| `ACARS_FREQUENCIES` | `129.125 130.025 130.425 130.450 131.125 131.550`         | Space-separated VHF channels (MHz)   |
| `ACARS_GAIN`        | `18`                                                      | Overall SDR gain                     |

## Note: `acars_decode.sh` is unused

`acars_decode.sh` is the older offline approach (decode recorded WAVs with
`multimon-ng`). It is no longer referenced by the `Dockerfile` or entrypoint
and is kept only for reference. The shipping decoder is the live `acarsdec`
+ SoapyRemote path above.
