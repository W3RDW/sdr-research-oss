# syntax=docker/dockerfile:1
#
# Combined HF decoder — time-shares one RX888 (via SoapyRemote) between HFDL
# (dumphfdl) and HF SSTV (slowrx-cli). None of dumphfdl, libacars, slowrx-cli,
# or the RX888/SDDC SoapySDR driver are packaged in Debian/Ubuntu apt, so all
# four are built from source via cmake/make on ubuntu:22.04.
#
# amd64 only. The SDDC/RX888 driver and its DSP are x86_64-oriented (AVX paths)
# and the production deployment pins to an amd64 node; arm64 is unsupported.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates build-essential cmake git pkg-config \
    libfftw3-dev libglib2.0-dev libconfig++-dev \
    libjansson-dev libzmq3-dev libliquid-dev \
    libsoapysdr-dev soapysdr-module-remote \
    libusb-1.0-0-dev \
    python3 python3-numpy python3-scipy python3-pil \
    python3-soapysdr \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth=1 https://github.com/szpajder/libacars /tmp/libacars \
    && cmake -S /tmp/libacars -B /tmp/libacars-build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/libacars-build --parallel "$(nproc)" \
    && cmake --install /tmp/libacars-build \
    && ldconfig \
    && rm -rf /tmp/libacars /tmp/libacars-build

RUN git clone --depth=1 https://github.com/szpajder/dumphfdl /tmp/dumphfdl \
    && cmake -S /tmp/dumphfdl -B /tmp/dumphfdl-build \
        -DCMAKE_BUILD_TYPE=Release -DSOAPYSDR=ON \
    && cmake --build /tmp/dumphfdl-build --parallel "$(nproc)" \
    && cmake --install /tmp/dumphfdl-build \
    && rm -rf /tmp/dumphfdl /tmp/dumphfdl-build

RUN git clone --depth=1 https://github.com/sgarriga/slowrx-cli /tmp/slowrx-cli \
    && make -C /tmp/slowrx-cli \
    && cp /tmp/slowrx-cli/slowrx-cli /usr/local/bin/ \
    && rm -rf /tmp/slowrx-cli

# RX888/SDDC SoapySDR driver. The pre-built FX3 firmware (SDDC_FX3.img) is
# committed in the ExtIO_sddc repo root, so it is copied straight from the
# checkout — there is no separate firmware download. The image lands at
# /usr/local/share/sddc/SDDC_FX3.img and is uploaded to the RX888's Cypress
# FX3 USB controller at runtime.
RUN git clone --depth 1 https://github.com/ik1xpv/ExtIO_sddc /tmp/sddc \
    && cmake -B /tmp/sddc/build -S /tmp/sddc \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DINSTALL_UDEV_RULES=OFF \
    && cmake --build /tmp/sddc/build --parallel "$(nproc)" \
    && cmake --install /tmp/sddc/build \
    && mkdir -p /usr/local/share/sddc \
    && cp /tmp/sddc/SDDC_FX3.img /usr/local/share/sddc/ \
    && ldconfig \
    && rm -rf /tmp/sddc

COPY hf-combined-entrypoint.py /hf-combined-entrypoint.py

ENTRYPOINT ["python3", "/hf-combined-entrypoint.py"]
