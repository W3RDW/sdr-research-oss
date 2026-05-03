#!/bin/sh
set -e
mkdir -p /data/text/vdl2
FREQ="${VDL2_FREQ_HZ:-136900000}"
SR="${VDL2_SAMPLE_RATE:-2048000}"
python3 /scripts/rtl_tcp_client.py | \
  dumpvdl2 --iq-input-format U8 --output-format text \
    --output file:/data/text/vdl2 --output-rotate 300 \
    --sample-rate "$SR" "$FREQ"
