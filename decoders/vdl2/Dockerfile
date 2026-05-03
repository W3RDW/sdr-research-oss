# syntax=docker/dockerfile:1
#
# VDL Mode 2 (aviation data link) decoder using dumpvdl2.
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      dumpvdl2 python3 bash \
    && rm -rf /var/lib/apt/lists/*

COPY rtl_tcp_client.py /app/rtl_tcp_client.py
COPY run_vdl2.sh /app/run_vdl2.sh
RUN chmod +x /app/run_vdl2.sh

CMD ["/app/run_vdl2.sh"]
