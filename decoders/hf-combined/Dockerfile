# syntax=docker/dockerfile:1
#
# Combined HF decoder — time-shares one RX888 (via SoapyRemote) between HFDL
# (dumphfdl) and HF SSTV (slowrx-cli). None of dumphfdl, libacars, slowrx-cli,
# or the RX888/SDDC SoapySDR driver are packaged in Debian/Ubuntu apt, so all
# four are built from source via cmake/make on ubuntu:22.04.
#
# amd64 only. The SDDC/RX888 driver and its DSP are x86_64-oriented (AVX paths)
# and the production deployment pins to an amd64 node; arm64 is unsupported.
#
# Multi-stage: everything is compiled in a builder stage and only /usr/local is
# copied into a runtime stage, so compilers, -dev packages and kernel headers
# (linux-libc-dev) do not ship in the image.

# === Build stage ===
FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates build-essential cmake git pkg-config \
    libfftw3-dev libglib2.0-dev libconfig++-dev \
    libjansson-dev libzmq3-dev libliquid-dev \
    libsoapysdr-dev \
    libusb-1.0-0-dev \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# SciPy from the upstream manylinux wheel (same 1.8.0 release as jammy's apt
# python3-scipy). On 22.04 the apt package hard-depends on python3-pythran,
# which drags gcc/python3-dev/linux-libc-dev into the runtime image. pip installs
# into /usr/local/lib/python3.10/dist-packages, which is copied below; numpy
# itself still comes from apt in the runtime stage.
RUN pip3 install --no-cache-dir --no-deps scipy==1.8.0

RUN git clone --depth=1 https://github.com/szpajder/libacars /tmp/libacars \
    && cmake -S /tmp/libacars -B /tmp/libacars-build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/libacars-build --parallel "$(nproc)" \
    && cmake --install /tmp/libacars-build \
    && ldconfig

RUN git clone --depth=1 https://github.com/szpajder/dumphfdl /tmp/dumphfdl \
    && cmake -S /tmp/dumphfdl -B /tmp/dumphfdl-build \
        -DCMAKE_BUILD_TYPE=Release -DSOAPYSDR=ON \
    && cmake --build /tmp/dumphfdl-build --parallel "$(nproc)" \
    && cmake --install /tmp/dumphfdl-build

RUN git clone --depth=1 https://github.com/sgarriga/slowrx-cli /tmp/slowrx-cli \
    && make -C /tmp/slowrx-cli \
    && cp /tmp/slowrx-cli/slowrx-cli /usr/local/bin/

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
    && cp /tmp/sddc/SDDC_FX3.img /usr/local/share/sddc/

# === Runtime stage ===
FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    libfftw3-single3 libfftw3-double3 libglib2.0-0 libconfig++9v5 \
    libjansson4 libzmq5 libliquid2d \
    libsoapysdr0.8 soapysdr-module-remote \
    libusb-1.0-0 libxml2 zlib1g \
    python3 python3-numpy python3-pil \
    python3-soapysdr \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/ /usr/local/
RUN ldconfig \
    && if ldd /usr/local/bin/* /usr/local/lib/SoapySDR/modules0.8/*.so /usr/local/lib/*.so* 2>/dev/null | grep -q 'not found'; then \
         ldd /usr/local/bin/* /usr/local/lib/SoapySDR/modules0.8/*.so /usr/local/lib/*.so*; exit 1; fi \
    && python3 -c 'import numpy, scipy.signal, PIL, SoapySDR; print("scipy", scipy.__version__)'

COPY hf-combined-entrypoint.py /hf-combined-entrypoint.py

ENTRYPOINT ["python3", "/hf-combined-entrypoint.py"]
