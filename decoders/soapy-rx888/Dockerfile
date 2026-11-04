# syntax=docker/dockerfile:1
#
# RX888 SoapyRemote server — exposes a USB RX888 / SDDC-class HF SDR over the
# network so decoder pods on other nodes can connect with `remote:driver=SDDC`.
#
# Builds SoapyRemote from source (for the SoapySDRServer binary) plus ExtIO_sddc
# (libsddc + the SoapySDDC plugin), then runs:
#   SoapySDRServer --bind 0.0.0.0:55132
#
# Build context is this directory (decoders/soapy-rx888/).
# In the reference cluster this image runs on an amd64 node, so the CI matrix
# publishes linux/amd64 for it. See README.md.
#
# Build:
#   docker buildx build --platform linux/amd64 -t sdr-research-soapy-rx888 .
#
# Built on ubuntu:22.04 (glibc 2.35) ON PURPOSE: this image's SoapySDDC plugin
# (libSDDCSupport.so) is copied by an init container into the ft8-wspr decoder,
# which is debian:bookworm-slim (glibc 2.36). A plugin built on a newer glibc
# (ubuntu:26.04 = glibc 2.43) fails to dlopen there ("GLIBC_2.43 not found").
# 22.04 keeps SoapySDR 0.8 / modules0.8 and carries libsoapysdr-dev/libusb/libfftw3.
#
# Multi-stage: everything is compiled in a builder stage and only /usr/local is
# copied into a runtime stage, so compilers, -dev packages and kernel headers
# (linux-libc-dev) do not ship in the image.

# === Build stage ===
FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# Build dependencies for ExtIO_sddc (libsddc + SoapySDDC module) and SoapyRemote server
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        cmake git make g++ pkg-config \
        libusb-1.0-0-dev libfftw3-dev \
        libsoapysdr-dev \
    && rm -rf /var/lib/apt/lists/*

# Build SoapyRemote from source — Ubuntu packages only ship the client .so,
# NOT the SoapySDRServer binary. We need to build it ourselves.
RUN git clone --depth=1 https://github.com/pothosware/SoapyRemote /tmp/SoapyRemote \
    && cmake -B /tmp/SoapyRemote/build -S /tmp/SoapyRemote \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/SoapyRemote/build --parallel "$(nproc)" \
    && cmake --install /tmp/SoapyRemote/build

# Build ExtIO_sddc — provides libsddc and the SoapySDDC SoapySDR plugin.
# Supports: RX888 MkII, RX888r2, RX999, RX-666, BBRF103, HF103.
# Firmware (SDDC_FX3.img) is included in the repo and installed to
# /usr/local/share/sddc/ — the driver loads it over USB on first open.
RUN git clone --depth 1 https://github.com/ik1xpv/ExtIO_sddc /tmp/sddc && \
    cmake -B /tmp/sddc/build -S /tmp/sddc \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DINSTALL_UDEV_RULES=OFF && \
    cmake --build /tmp/sddc/build --parallel "$(nproc)" && \
    cmake --install /tmp/sddc/build

# === Runtime stage ===
FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libusb-1.0-0 libfftw3-single3 \
        libsoapysdr0.8 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/ /usr/local/
RUN ldconfig \
    && if ldd /usr/local/bin/SoapySDRServer /usr/local/lib/SoapySDR/modules0.8/*.so /usr/local/lib/*.so* 2>/dev/null | grep -q 'not found'; then \
         ldd /usr/local/bin/SoapySDRServer /usr/local/lib/SoapySDR/modules0.8/*.so /usr/local/lib/*.so*; exit 1; fi

EXPOSE 55132

# Serve the RX888 over SoapyRemote protocol.
# The sddc driver (SoapySDDC module) will be auto-discovered by SoapySDRServer.
CMD ["SoapySDRServer", "--bind", "0.0.0.0:55132"]
