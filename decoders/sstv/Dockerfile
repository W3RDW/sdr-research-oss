# syntax=docker/dockerfile:1
# SSTV decoder image — slowrx-cli (headless) for WAV→BMP decode, Pillow for
# BMP→PNG, and SoapySDR Python bindings for the HF direct-connect mode.
#
# Ships TWO entrypoints from one image:
#   /sstv-entrypoint.py     (default) — VHF/UHF: watches WAV files on the
#                                       shared artifacts volume.
#   /sstv-hf-entrypoint.py            — HF: direct RX888 capture via SoapyRemote.
# The default ENTRYPOINT runs the VHF watcher; the HF deployment overrides the
# container command to run /sstv-hf-entrypoint.py.
#
# Multi-stage: slowrx-cli is compiled in a builder stage so the compiler
# toolchain and kernel headers (linux-libc-dev) do not ship in the runtime image.

# === Build stage ===
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates build-essential git \
    libfftw3-dev \
    && rm -rf /var/lib/apt/lists/*

# Build slowrx-cli — headless SSTV decoder (no GTK/SDL required)
RUN git clone --depth=1 https://github.com/sgarriga/slowrx-cli /tmp/slowrx-cli \
    && make -C /tmp/slowrx-cli \
    && cp /tmp/slowrx-cli/slowrx-cli /usr/local/bin/

# === Runtime stage ===
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    libfftw3-double3 \
    python3 python3-numpy python3-scipy python3-pil \
    python3-soapysdr soapysdr-module-remote \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/slowrx-cli /usr/local/bin/slowrx-cli
RUN if ldd /usr/local/bin/slowrx-cli | grep -q 'not found'; then ldd /usr/local/bin/slowrx-cli; exit 1; fi

COPY sstv-entrypoint.py /sstv-entrypoint.py
COPY sstv-hf-entrypoint.py /sstv-hf-entrypoint.py

# Default = VHF/UHF WAV watcher. HF deployment overrides this with
# command: ["python3", "/sstv-hf-entrypoint.py"].
ENTRYPOINT ["python3", "/sstv-entrypoint.py"]
