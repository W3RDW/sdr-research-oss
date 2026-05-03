# syntax=docker/dockerfile:1
#
# FT8 / WSPR weak-signal HF decoder. Uses jt9 (FT8) and wsprd (WSPR) from
# the wsjtx project. Audio capture is done by the unified-sdr container at
# the appropriate band; this container only does the decode + JSON write.
#
# This image is a placeholder — bring your own ft8-wspr decoder script.
# See decoders/ft8-wspr/README.md for the expected interface.
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      wsjtx sox bash python3 \
    && rm -rf /var/lib/apt/lists/*

COPY ft8_wspr_decode.sh /app/ft8_wspr_decode.sh
RUN chmod +x /app/ft8_wspr_decode.sh

CMD ["/app/ft8_wspr_decode.sh"]
