# syntax=docker/dockerfile:1
#
# ACARS (Aircraft Communications Addressing and Reporting System) decoder.
# acarsdec and libacars are not packaged in Debian/Ubuntu apt, so build both
# from source via cmake. Connects to an Airspy over SoapyRemote.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates build-essential cmake git pkg-config \
    libjansson-dev \
    libxml2-dev \
    libsoapysdr-dev soapysdr-module-remote \
    librtlsdr-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth=1 https://github.com/szpajder/libacars /tmp/libacars \
    && cmake -S /tmp/libacars -B /tmp/libacars-build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/libacars-build --parallel "$(nproc)" \
    && cmake --install /tmp/libacars-build \
    && ldconfig \
    && rm -rf /tmp/libacars /tmp/libacars-build

RUN git clone --depth=1 https://github.com/TLeconte/acarsdec /tmp/acarsdec \
    && mkdir -p /tmp/acarsdec-build && cd /tmp/acarsdec-build \
    && cmake /tmp/acarsdec \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build . --parallel "$(nproc)" \
    && cmake --install . \
    && ldconfig \
    && rm -rf /tmp/acarsdec /tmp/acarsdec-build

COPY acars-entrypoint.py /acars-entrypoint.py

ENTRYPOINT ["python3", "/acars-entrypoint.py"]
