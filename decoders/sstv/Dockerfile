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
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates build-essential git \
    libfftw3-dev \
    python3 python3-numpy python3-scipy python3-pil \
    python3-soapysdr soapysdr-module-remote \
    && rm -rf /var/lib/apt/lists/*

# Build slowrx-cli — headless SSTV decoder (no GTK/SDL required)
RUN git clone --depth=1 https://github.com/sgarriga/slowrx-cli /tmp/slowrx-cli \
    && make -C /tmp/slowrx-cli \
    && cp /tmp/slowrx-cli/slowrx-cli /usr/local/bin/ \
    && rm -rf /tmp/slowrx-cli

COPY sstv-entrypoint.py /sstv-entrypoint.py
COPY sstv-hf-entrypoint.py /sstv-hf-entrypoint.py

# Default = VHF/UHF WAV watcher. HF deployment overrides this with
# command: ["python3", "/sstv-hf-entrypoint.py"].
ENTRYPOINT ["python3", "/sstv-entrypoint.py"]
