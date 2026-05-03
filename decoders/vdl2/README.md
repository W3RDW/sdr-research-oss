# VDL Mode 2 decoder

Decodes VHF Data Link Mode 2 (digital aviation data link replacing/augmenting
ACARS), running around 136 MHz.

## Status: build script TODO

The current `Dockerfile` references `dumpvdl2` from Debian apt, but it isn't
packaged there. To make this image build you need one of:

1. **Build from source** — clone <https://github.com/szpajder/dumpvdl2> and
   compile in the Dockerfile (depends on `librtlsdr`, `libacars`).
2. **Use a community base image** — e.g. `ghcr.io/sdr-enthusiasts/docker-dumpvdl2:latest`
   already has it baked in.

PRs welcome to land either approach. Until then this decoder is excluded
from the GHCR CI build matrix.
