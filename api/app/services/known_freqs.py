"""
Static lookup table of well-known frequencies.

Frequencies are stored in Hz with a match tolerance. The first match wins,
so list more specific entries (narrow-band) before broader band ranges.
Edit this configmap to add or adjust entries without rebuilding the image.
"""

import re
from typing import Optional


_GROUP_LABELS = {
    "ham": "Ham",
    "emergency": "Emergency / Safety",
    "other": "Other",
}

_HAM_BANDS_HZ = (
    (1_800_000, 2_000_000),
    (3_500_000, 4_000_000),
    (5_330_500, 5_406_500),
    (7_000_000, 7_300_000),
    (10_100_000, 10_150_000),
    (14_000_000, 14_350_000),
    (18_068_000, 18_168_000),
    (21_000_000, 21_450_000),
    (24_890_000, 24_990_000),
    (28_000_000, 29_700_000),
    (50_000_000, 54_000_000),
    (144_000_000, 148_000_000),
    (222_000_000, 225_000_000),
    (420_000_000, 450_000_000),
)
_EMERGENCY_BANDS_HZ = (
    (121_450_000, 121_550_000),
    (150_000_000, 162_625_000),
)
_HAM_LABEL_RE = re.compile(
    r"\b(?:HAM|AMATEUR|APRS|ISS|2M|6M|10M|12M|15M|17M|20M|30M|40M|60M|70CM|80M|160M|1\.25M)\b",
    re.IGNORECASE,
)
_EMERGENCY_LABEL_RE = re.compile(
    r"\b(?:NOAA|WX|WEATHER|DISTRESS|GUARD|USCG|COAST GUARD|SAFETY|EMERGENCY|FIRE|EMS|RESCUE|POLICE|SHERIFF|DISPATCH|AIR-TO-AIR|MULTICOM|UNICOM|MARINE|AVIATION)\b",
    re.IGNORECASE,
)


# (center_hz, tolerance_hz, label, group)
_KNOWN: list[tuple[float, float, str, str]] = [
    # ── NOAA Weather Radio ────────────────────────────────────────────────
    (162_400_000, 3_000, "NOAA WX-1", "emergency"),
    (162_425_000, 3_000, "NOAA WX-2", "emergency"),
    (162_450_000, 3_000, "NOAA WX-3", "emergency"),
    (162_475_000, 3_000, "NOAA WX-4", "emergency"),
    (162_500_000, 3_000, "NOAA WX-5", "emergency"),
    (162_525_000, 3_000, "NOAA WX-6", "emergency"),
    (162_550_000, 3_000, "NOAA WX-7", "emergency"),

    # ── Amateur — 2m ──────────────────────────────────────────────────────
    (144_200_000, 3_000, "2m SSB Calling", "ham"),
    (144_390_000, 20_000, "APRS 2m", "ham"),
    (146_520_000, 5_000, "2m National Simplex Calling", "ham"),
    (146_580_000, 5_000, "2m FM Simplex", "ham"),
    (147_555_000, 5_000, "2m FM Simplex", "ham"),

    # ── Amateur — 70cm ────────────────────────────────────────────────────
    (432_100_000, 3_000, "70cm SSB Calling", "ham"),
    (433_920_000, 5_000, "70cm FM Simplex", "ham"),
    (446_000_000, 5_000, "70cm National Simplex Calling", "ham"),
    (446_500_000, 5_000, "70cm FM Simplex", "ham"),

    # ── Amateur — 1.25m ───────────────────────────────────────────────────
    (223_500_000, 5_000, "1.25m National Simplex Calling", "ham"),

    # ── ISS ───────────────────────────────────────────────────────────────
    (145_800_000, 5_000, "ISS Voice Downlink", "ham"),
    (437_550_000, 5_000, "ISS Packet", "ham"),
    (145_825_000, 20_000, "ISS APRS", "ham"),

    # ── Aviation ──────────────────────────────────────────────────────────
    (121_500_000, 5_000, "Aviation Distress (Guard)", "emergency"),
    (122_750_000, 5_000, "Aviation Multicom", "emergency"),
    (123_025_000, 5_000, "Aviation Unicom", "emergency"),
    (123_450_000, 5_000, "Aviation Air-to-Air", "emergency"),

    # ── Marine VHF ───────────────────────────────────────────────────────
    (156_800_000, 5_000, "Marine Ch 16 (Distress/Calling)", "emergency"),
    (156_300_000, 5_000, "Marine Ch 6 (Safety)", "emergency"),
    (157_050_000, 5_000, "Marine Ch 22A (USCG Working)", "emergency"),

    # ── FRS/GMRS simplex ─────────────────────────────────────────────────
    (462_562_500, 5_000, "FRS/GMRS Ch 1", "other"),
    (462_587_500, 5_000, "FRS/GMRS Ch 2", "other"),
    (462_612_500, 5_000, "FRS/GMRS Ch 3", "other"),
    (462_637_500, 5_000, "FRS/GMRS Ch 4", "other"),
    (462_662_500, 5_000, "FRS/GMRS Ch 5", "other"),
    (462_687_500, 5_000, "FRS/GMRS Ch 6", "other"),
    (462_712_500, 5_000, "FRS/GMRS Ch 7", "other"),
    (467_562_500, 5_000, "FRS Ch 8", "other"),
    (467_587_500, 5_000, "FRS Ch 9", "other"),
    (467_612_500, 5_000, "FRS Ch 10", "other"),
    (467_637_500, 5_000, "FRS Ch 11", "other"),
    (467_662_500, 5_000, "FRS Ch 12", "other"),
    (467_687_500, 5_000, "FRS Ch 13", "other"),
    (467_712_500, 5_000, "FRS Ch 14", "other"),
    (462_550_000, 5_000, "GMRS Ch 15 (Calling)", "other"),
    (462_575_000, 5_000, "GMRS Ch 16", "other"),
    (462_600_000, 5_000, "GMRS Ch 17", "other"),
    (462_625_000, 5_000, "GMRS Ch 18", "other"),
    (462_650_000, 5_000, "GMRS Ch 19", "other"),
    (462_675_000, 5_000, "GMRS Ch 20", "other"),
    (462_700_000, 5_000, "GMRS Ch 21", "other"),
    (462_725_000, 5_000, "GMRS Ch 22", "other"),

    # ── MURS ─────────────────────────────────────────────────────────────
    (151_820_000, 5_000, "MURS Ch 1", "other"),
    (151_880_000, 5_000, "MURS Ch 2", "other"),
    (151_940_000, 5_000, "MURS Ch 3", "other"),
    (154_570_000, 5_000, "MURS Ch 4", "other"),
    (154_600_000, 5_000, "MURS Ch 5", "other"),
]


def lookup_known_freq_metadata(frequency_hz: float) -> Optional[dict[str, str]]:
    """Return known-frequency metadata, or None if unrecognized."""
    for center, tolerance, label, group in _KNOWN:
        if abs(frequency_hz - center) <= tolerance:
            return {
                "label": label,
                "group": group,
                "group_label": _GROUP_LABELS.get(group, _GROUP_LABELS["other"]),
            }
    return None


def lookup_known_freq(frequency_hz: float) -> Optional[str]:
    """Return a human label for a known frequency, or None if unrecognized."""
    metadata = lookup_known_freq_metadata(frequency_hz)
    return metadata["label"] if metadata else None


def lookup_known_freq_group(frequency_hz: float) -> Optional[str]:
    metadata = lookup_known_freq_metadata(frequency_hz)
    return metadata["group"] if metadata else None


def frequency_group_label(group: Optional[str]) -> str:
    return _GROUP_LABELS.get(group or "other", _GROUP_LABELS["other"])


def is_ham_frequency_hz(frequency_hz: float | None) -> bool:
    if frequency_hz is None:
        return False
    hz = int(round(frequency_hz))
    return any(low <= hz <= high for (low, high) in _HAM_BANDS_HZ)


def classify_frequency_group(
    frequency_hz: float | None,
    label: str | None = None,
    mode: str | None = None,
    repeater_id: int | None = None,
) -> str:
    if repeater_id is not None:
        return "ham"
    if frequency_hz is not None:
        known_group = lookup_known_freq_group(frequency_hz)
        if known_group:
            return known_group
    if (mode or "").lower() == "aprs":
        return "ham"

    normalized_label = (label or "").strip()
    if normalized_label and _HAM_LABEL_RE.search(normalized_label):
        return "ham"
    if normalized_label and _EMERGENCY_LABEL_RE.search(normalized_label):
        return "emergency"
    if is_ham_frequency_hz(frequency_hz):
        return "ham"

    if frequency_hz is not None:
        hz = int(round(frequency_hz))
        if any(low <= hz <= high for (low, high) in _EMERGENCY_BANDS_HZ):
            return "emergency"
    return "other"
