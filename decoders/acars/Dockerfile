# syntax=docker/dockerfile:1
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      acarsdec sox bash \
    && rm -rf /var/lib/apt/lists/*

COPY acars_decode.sh /app/acars_decode.sh
RUN chmod +x /app/acars_decode.sh

CMD ["/app/acars_decode.sh"]
