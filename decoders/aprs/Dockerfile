# syntax=docker/dockerfile:1
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      multimon-ng sox bash \
    && rm -rf /var/lib/apt/lists/*

COPY aprs_decode.sh /app/aprs_decode.sh
RUN chmod +x /app/aprs_decode.sh

CMD ["/app/aprs_decode.sh"]
