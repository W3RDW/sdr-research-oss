# syntax=docker/dockerfile:1
#
# VDL Mode 2 (aviation data link) decoder using dumpvdl2.
# dumpvdl2 + libacars are not packaged in Debian/Ubuntu apt, so we build both
# from source with SoapySDR enabled (-DSOAPYSDR=ON) for SoapyRemote operation.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates build-essential cmake git pkg-config \
    libglib2.0-dev libconfig++-dev \
    libjansson-dev libzmq3-dev \
    libsoapysdr-dev soapysdr-module-remote \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth=1 https://github.com/szpajder/libacars /tmp/libacars \
    && cmake -S /tmp/libacars -B /tmp/libacars-build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/libacars-build --parallel "$(nproc)" \
    && cmake --install /tmp/libacars-build \
    && ldconfig \
    && rm -rf /tmp/libacars /tmp/libacars-build

RUN git clone --depth=1 https://github.com/szpajder/dumpvdl2 /tmp/dumpvdl2 \
    && cmake -S /tmp/dumpvdl2 -B /tmp/dumpvdl2-build \
        -DCMAKE_BUILD_TYPE=Release -DSOAPYSDR=ON \
    && cmake --build /tmp/dumpvdl2-build --parallel "$(nproc)" \
    && cmake --install /tmp/dumpvdl2-build \
    && rm -rf /tmp/dumpvdl2 /tmp/dumpvdl2-build

COPY vdl2-entrypoint.py /vdl2-entrypoint.py

ENTRYPOINT ["python3", "/vdl2-entrypoint.py"]
