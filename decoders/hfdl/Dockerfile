# syntax=docker/dockerfile:1
#
# HFDL (High Frequency Data Link) decoder — dumphfdl built from source with
# SoapySDR support, for use with an HF SDR (e.g. RX888) over SoapyRemote.
#
# Build context is this directory (decoders/hfdl/), so COPY paths are relative.
# Multi-arch note: this image is amd64-only. dumphfdl/libacars build fine on
# arm64, but the typical RX888 SoapyRemote path is exercised on amd64 only —
# CI builds linux/amd64. See README.md.
#
# Build:
#   docker buildx build --platform linux/amd64 -t sdr-research-hfdl .
#
# Base image matches the production Dockerfile.hfdl (ubuntu:26.04 LTS, released
# Apr 2026), which carries all the Soapy/libacars build dependencies below.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      build-essential cmake git pkg-config \
      libsoapysdr-dev soapysdr-module-remote \
      libfftw3-dev libglib2.0-dev libconfig++-dev \
      libjansson-dev libzmq3-dev \
      libliquid-dev \
      python3 \
    && rm -rf /var/lib/apt/lists/*

# Build libacars (required by dumphfdl) from source.
RUN git clone --depth=1 https://github.com/szpajder/libacars /opt/libacars-src \
    && cmake -S /opt/libacars-src -B /opt/libacars-build \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /opt/libacars-build --parallel "$(nproc)" \
    && cmake --install /opt/libacars-build \
    && ldconfig \
    && rm -rf /opt/libacars-src /opt/libacars-build

# Build dumphfdl from source with SoapySDR support.
RUN git clone --depth=1 https://github.com/szpajder/dumphfdl /opt/dumphfdl-src \
    && cmake -S /opt/dumphfdl-src -B /opt/dumphfdl-build \
        -DCMAKE_BUILD_TYPE=Release \
        -DSOAPYSDR=ON \
    && cmake --build /opt/dumphfdl-build --parallel "$(nproc)" \
    && cmake --install /opt/dumphfdl-build \
    && rm -rf /opt/dumphfdl-src /opt/dumphfdl-build

COPY hfdl-entrypoint.py /hfdl-entrypoint.py

ENTRYPOINT ["python3", "/hfdl-entrypoint.py"]
