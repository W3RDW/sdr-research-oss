# syntax=docker/dockerfile:1
#
# Unified SDR flowgraph runner — GNURadio + osmosdr + Python.
# Supports RTL-SDR, Airspy, RX888 (via SoapySDR drivers).
#
# Multi-arch build:
#   docker buildx build --platform linux/amd64,linux/arm64 -t IMAGE .

FROM librespace/gnuradio:latest

WORKDIR /app

# Most SoapySDR / osmosdr modules ship in the librespace base image.
# Add additional drivers if needed (uncomment per device):
#   - airspy:    soapyairspy
#   - airspyhf:  soapyairspyhf
#   - hackrf:    soapyhackrf
#   - rtlsdr:    soapyrtlsdr (also handles rtl_tcp)
#   - sdrplay:   soapysdrplay3 (proprietary, not in apt)
#   - rx888:     soapysddc (build from source — see decoders/unified-sdr/sddc.md)
RUN apt-get update && apt-get install -y --no-install-recommends \
      soapysdr-module-airspy \
      soapysdr-module-airspyhf \
      soapysdr-module-rtlsdr \
      soapysdr-module-remote \
      soapyremote-server \
      libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY bandplan.py unified_sdr.py /app/

# Output directory mounted by host / k8s. Created here as a default.
RUN mkdir -p /data/audio /data/text /data/detections

CMD ["python3", "-u", "/app/unified_sdr.py"]
