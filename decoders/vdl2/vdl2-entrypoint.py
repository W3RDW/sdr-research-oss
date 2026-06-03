#!/usr/bin/env python3
"""VDL2 decoder wrapper for sdr-research.

Runs dumpvdl2 connected to the Airspy Mini via SoapyRemote and writes one JSON
file per decoded frame to VDL2_OUTPUT_DIR (default /data/text/vdl2).
The sdr-viewer API indexer picks these up as mode='vdl2' recordings.
"""

import json
import os
import subprocess
import sys
import time

SOAPY_REMOTE = os.getenv("SOAPY_REMOTE", "airspy-soapy.sdr-research.svc.cluster.local:55132")
OUTPUT_DIR = os.getenv("VDL2_OUTPUT_DIR", "/data/text/vdl2")
# VDL2 frequencies in Hz — primary European/US channels
FREQUENCIES = os.getenv(
    "VDL2_FREQUENCIES",
    "136725000 136775000 136800000 136875000 136975000",
).split()
GAIN = os.getenv("VDL2_GAIN", "18")

os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f"[VDL2] Starting dumpvdl2 | remote={SOAPY_REMOTE}", flush=True)
print(f"[VDL2] Frequencies: {' '.join(FREQUENCIES)} Hz", flush=True)
print(f"[VDL2] Output dir : {OUTPUT_DIR}", flush=True)

cmd = [
    "dumpvdl2",
    "--soapysdr", f"driver=remote,remote=tcp://{SOAPY_REMOTE},remote:driver=airspy",
    "--gain-elements", f"LNA={GAIN}",
    "--output", "decoded:json:file:path=-",
] + FREQUENCIES

proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, bufsize=1)

for line in proc.stdout:
    line = line.strip()
    if not line:
        continue
    try:
        frame = json.loads(line)
        freq = frame.get("freq", 0)
        ts = int(time.time() * 1000)
        filename = f"vdl2_{freq}_{ts}.json"
        filepath = os.path.join(OUTPUT_DIR, filename)
        with open(filepath, "w") as f:
            json.dump(frame, f)
        print(f"[VDL2] {filename}", flush=True)
    except (json.JSONDecodeError, KeyError, ValueError, OSError) as exc:
        print(f"[VDL2] Error: {exc}: {line[:100]}", flush=True)

rc = proc.wait()
print(f"[VDL2] dumpvdl2 exited with code {rc}", flush=True)
sys.exit(rc)
