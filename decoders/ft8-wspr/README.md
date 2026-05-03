# FT8 / WSPR decoder

The decoder script (`ft8_wspr_decode.sh`) is not bundled in this OSS release —
the upstream production version cycles through 8 FT8 + 5 WSPR bands and writes
spot JSON to `/data/text/ft8/`.

To use FT8/WSPR, either:

1. Adapt `wsjtx`'s `jt9` and `wsprd` CLIs to your audio capture pipeline, or
2. Run a full WSJT-X instance and parse `ALL.TXT` / `wspr_spots.txt`.

The API expects spot JSON files at `/data/text/ft8/*.json` with this shape:

```json
{
  "timestamp": 1714699200,
  "frequency_hz": 14076000,
  "mode": "ft8",
  "callsign": "K1ABC",
  "grid": "FN42",
  "snr_db": -12,
  "drift_hz": 0
}
```

`api/app/services/indexer.py` picks these up and inserts into the `spots`
table. PRs welcome to land a working decoder script.
