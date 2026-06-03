# syntax=docker/dockerfile:1
#
# Airspy SoapyRemote server — exposes a USB Airspy (Mini / R2) SDR over the
# network so decoder pods on other nodes can connect with `remote:driver=airspy`.
#
# Builds SoapyRemote from source (for the SoapySDRServer binary) plus the
# Ubuntu soapysdr-module-airspy plugin, then runs:
#   SoapySDRServer --bind 0.0.0.0:55132
#
# Build context is this directory (decoders/soapy-airspy/).
# In the reference cluster this image runs on an arm64 bare-metal node, so the
# CI matrix publishes linux/arm64 for it. See README.md.
#
# Build:
#   docker buildx build --platform linux/arm64 -t sdr-research-soapy-airspy .
#
# Base image matches the production Dockerfile.soapy-airspy (ubuntu:26.04 LTS),
# which carries libsoapysdr-dev and soapysdr-module-airspy below.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# SoapySDR core + Airspy module.
# SoapySDRServer must be built from SoapyRemote source —
# the Ubuntu soapysdr-module-remote package only ships the client .so, not the server binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates build-essential cmake git pkg-config \
        libsoapysdr-dev \
        soapysdr-module-airspy \
        libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Build SoapyRemote from source to get the SoapySDRServer binary.
RUN git clone --depth=1 https://github.com/pothosware/SoapyRemote /tmp/SoapyRemote \
    && cmake -B /tmp/SoapyRemote/build -S /tmp/SoapyRemote \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/SoapyRemote/build --parallel "$(nproc)" \
    && cmake --install /tmp/SoapyRemote/build \
    && ldconfig \
    && rm -rf /tmp/SoapyRemote

EXPOSE 55132

# Bind on all interfaces so Kubernetes pods on other nodes can reach this server.
CMD ["SoapySDRServer", "--bind", "0.0.0.0:55132"]
