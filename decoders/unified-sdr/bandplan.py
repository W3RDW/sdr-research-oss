"""Frequency-band helpers for unified-sdr peak routing.

The FFT detector sees occupied RF peaks, not modulation intent. A quiet FM
repeater carrier can look spectrally narrow enough to be mistaken for CW, so
we route by band plan first and only allow CW in explicit CW subbands.
"""

from __future__ import annotations

from typing import Iterable

FrequencyRange = tuple[int, int]


# Defaults are intentionally conservative for a VHF/UHF voice recorder:
# - 2 m FM voice/APRS/repeater space
# - VHF pager/public-safety data that is routed to the pager decoder
# - 1.25 m and 70 cm amateur FM/repeater space
DEFAULT_FM_RECORD_BANDS = (
    "144300000-148000000,"
    "150000000-162000000,"
    "222000000-225000000,"
    "433000000-450000000"
)

# CW is narrow by nature, but "narrow" alone is not enough. Limit dynamic CW
# to weak-signal/CW slices so quiet FM repeaters do not become CW noise files.
DEFAULT_CW_RECORD_BANDS = "144000000-144150000,432000000-432100000"


def _parse_hz(value: str) -> int:
    cleaned = value.strip().lower().replace("_", "").replace(" ", "")
    if cleaned.endswith("mhz"):
        return int(float(cleaned[:-3]) * 1_000_000)
    if cleaned.endswith("hz"):
        return int(float(cleaned[:-2]))
    parsed = float(cleaned)
    # Friendly shorthand: values under 1000 are treated as MHz.
    if parsed < 1000:
        parsed *= 1_000_000
    return int(parsed)


def parse_frequency_ranges(raw: str | None, default: str) -> tuple[FrequencyRange, ...]:
    """Parse comma-separated frequency ranges.

    Accepted examples:
    - "144300000-148000000,433000000-450000000"
    - "144.3MHz-148MHz,420-450"

    Passing an empty string intentionally disables that band list.
    """
    value = default if raw is None else raw
    if not value.strip():
        return ()

    ranges: list[FrequencyRange] = []
    for part in value.split(","):
        item = part.strip()
        if not item:
            continue
        if "-" not in item:
            center = _parse_hz(item)
            ranges.append((center, center))
            continue
        low_raw, high_raw = item.split("-", 1)
        low = _parse_hz(low_raw)
        high = _parse_hz(high_raw)
        if high < low:
            low, high = high, low
        ranges.append((low, high))
    return tuple(ranges)


def in_frequency_ranges(freq_hz: float, ranges: Iterable[FrequencyRange]) -> bool:
    hz = int(round(freq_hz))
    return any(low <= hz <= high for low, high in ranges)


def classify_peak_for_recording(
    freq_hz: float,
    *,
    fm_record_bands: Iterable[FrequencyRange],
    cw_record_bands: Iterable[FrequencyRange],
    acars_min_hz: int,
    acars_max_hz: int,
) -> str | None:
    """Return the recorder family for a detected FFT peak.

    Returns "ACARS", "FM", "CW", or None when the peak should be shown in
    detections but not assigned to a recorder slot.
    """
    if acars_min_hz <= freq_hz <= acars_max_hz:
        return "ACARS"
    if in_frequency_ranges(freq_hz, fm_record_bands):
        return "FM"
    if in_frequency_ranges(freq_hz, cw_record_bands):
        return "CW"
    return None
