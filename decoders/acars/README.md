# ACARS decoder

Decodes ACARS (Aircraft Communications Addressing and Reporting System)
messages from VHF aviation airband (~131 MHz).

## Status: build script TODO

The current `Dockerfile` references `acarsdec` from Debian apt, but it isn't
packaged there. To make this image build you need one of:

1. **Build from source** — clone <https://github.com/TLeconte/acarsdec> and
   compile in the Dockerfile (depends on `librtlsdr`, `libacars`, `libusb-1.0`).
2. **Use a community base image** — e.g. `ghcr.io/sdr-enthusiasts/docker-acarsdec:latest`
   already has it baked in.

PRs welcome to land either approach. Until then this decoder is excluded
from the GHCR CI build matrix.
