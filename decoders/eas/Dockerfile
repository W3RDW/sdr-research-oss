# syntax=docker/dockerfile:1
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      multimon-ng sox bash \
    && rm -rf /var/lib/apt/lists/*

COPY eas_decode.sh /app/eas_decode.sh
RUN chmod +x /app/eas_decode.sh

CMD ["/app/eas_decode.sh"]
