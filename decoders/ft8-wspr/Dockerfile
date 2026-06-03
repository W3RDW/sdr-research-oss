# syntax=docker/dockerfile:1
#
# Unified HF decoder — combines FT8/WSPR, HFDL, and SSTV in one image.
# All tools share a single RX888 (via SoapyRemote / SoapySDDC), time-sharing
# the radio in rotation. The RX888 SoapyRemote server serves one client at a
# time, so this decoder must be the only consumer of that radio while running.
#
# Build (amd64 — see README for the arm64 caveat):
#   docker buildx build --platform linux/amd64 -t sdr-research-ft8-wspr .
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# --- Base deps shared by all decoders ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 python3-numpy python3-scipy python3-pil \
    python3-soapysdr \
    libsoapysdr-dev soapysdr-tools soapysdr-module-remote \
    libusb-1.0-0 \
    sox \
    build-essential cmake git pkg-config \
    # FT8/WSPR: jt9 + wsprd from wsjtx
    wsjtx \
    # HFDL: build deps for libacars + dumphfdl
    libfftw3-dev libglib2.0-dev libconfig++-dev \
    libjansson-dev libzmq3-dev libliquid-dev \
    && rm -rf /var/lib/apt/lists/*

# --- rx_tools (rx_sdr for SoapySDR CLI capture) ---
RUN git clone --depth=1 https://github.com/rxseger/rx_tools /tmp/rx_tools \
    && cmake -S /tmp/rx_tools -B /tmp/rx_tools-build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/rx_tools-build --parallel "$(nproc)" \
    && cmake --install /tmp/rx_tools-build \
    && rm -rf /tmp/rx_tools /tmp/rx_tools-build

# --- libacars (required by dumphfdl) ---
RUN git clone --depth=1 https://github.com/szpajder/libacars /tmp/libacars \
    && cmake -S /tmp/libacars -B /tmp/libacars-build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/libacars-build --parallel "$(nproc)" \
    && cmake --install /tmp/libacars-build \
    && ldconfig \
    && rm -rf /tmp/libacars /tmp/libacars-build

# --- dumphfdl (HFDL aviation datalink decoder) ---
RUN git clone --depth=1 https://github.com/szpajder/dumphfdl /tmp/dumphfdl \
    && cmake -S /tmp/dumphfdl -B /tmp/dumphfdl-build \
        -DCMAKE_BUILD_TYPE=Release -DSOAPYSDR=ON \
    && cmake --build /tmp/dumphfdl-build --parallel "$(nproc)" \
    && cmake --install /tmp/dumphfdl-build \
    && rm -rf /tmp/dumphfdl /tmp/dumphfdl-build

# --- slowrx-cli (headless SSTV decoder) ---
RUN git clone --depth=1 https://github.com/sgarriga/slowrx-cli /tmp/slowrx-cli \
    && make -C /tmp/slowrx-cli \
    && cp /tmp/slowrx-cli/slowrx-cli /usr/local/bin/ \
    && rm -rf /tmp/slowrx-cli

# --- Cleanup build tools ---
RUN apt-get purge -y build-essential cmake git pkg-config \
    && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY ft8-wspr-entrypoint.py /app/ft8-wspr-entrypoint.py

WORKDIR /app
ENTRYPOINT ["python3", "/app/ft8-wspr-entrypoint.py"]
