"""
Pure-logic tests for the frequency-classification helpers — these have zero
external dependencies and are fast.
"""

import pytest


@pytest.mark.parametrize("hz,expected", [
    (146_520_000, "ham"),       # 2m simplex
    (147_345_000, "ham"),       # 2m FM
    (144_390_000, "ham"),       # APRS 2m
    (432_100_000, "ham"),       # 70cm SSB
    (162_550_000, "emergency"), # NOAA WX
    (156_800_000, "emergency"), # Marine Ch 16
    (121_500_000, "emergency"), # Aviation guard
    (462_562_500, "other"),     # FRS Ch 1
    (151_820_000, "other"),     # MURS Ch 1
    (88_500_000, "other"),      # FM broadcast — none of our buckets
])
def test_classify_frequency_group(hz, expected):
    from app.services.known_freqs import classify_frequency_group
    assert classify_frequency_group(hz) == expected


def test_aprs_mode_classifies_as_ham():
    from app.services.known_freqs import classify_frequency_group
    # Even at a non-ham freq, mode=aprs forces ham
    assert classify_frequency_group(100_000_000, mode="aprs") == "ham"


def test_repeater_id_forces_ham():
    from app.services.known_freqs import classify_frequency_group
    # repeater_id=anything forces ham regardless of freq
    assert classify_frequency_group(100_000_000, repeater_id=42) == "ham"


def test_label_regex_classifies():
    from app.services.known_freqs import classify_frequency_group
    assert classify_frequency_group(100_000_000, label="2m FM") == "ham"
    assert classify_frequency_group(100_000_000, label="NOAA WX-1") == "emergency"
    assert classify_frequency_group(100_000_000, label="Random Label") == "other"
