# syntax=docker/dockerfile:1
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      multimon-ng sox bash \
    && rm -rf /var/lib/apt/lists/*

COPY pager_decode.sh /app/pager_decode.sh
RUN chmod +x /app/pager_decode.sh

CMD ["/app/pager_decode.sh"]
