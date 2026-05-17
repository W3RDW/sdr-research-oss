"""
Pure tests for unified-sdr peak routing.

These guard against the production failure mode where narrow/quiet FM
repeater carriers were assigned to CW slots and never reached Whisper.
"""

import importlib.util
from pathlib import Path


def _load_bandplan():
    repo_root = Path(__file__).resolve().parents[2]
    path = repo_root / "decoders" / "unified-sdr" / "bandplan.py"
    spec = importlib.util.spec_from_file_location("unified_sdr_bandplan", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


bandplan = _load_bandplan()


def _default_fm():
    return bandplan.parse_frequency_ranges(
        None, bandplan.DEFAULT_FM_RECORD_BANDS
    )


def _default_cw():
    return bandplan.parse_frequency_ranges(
        None, bandplan.DEFAULT_CW_RECORD_BANDS
    )


def _classify(freq_hz):
    return bandplan.classify_peak_for_recording(
        freq_hz,
        fm_record_bands=_default_fm(),
        cw_record_bands=_default_cw(),
        acars_min_hz=128_000_000,
        acars_max_hz=132_000_000,
    )


def test_narrow_repeater_voice_prefers_fm_over_cw():
    assert _classify(146_940_000) == "FM"
    assert _classify(147_345_000) == "FM"


def test_70cm_repeater_voice_is_recordable_fm():
    assert _classify(442_125_000) == "FM"
    assert _classify(446_000_000) == "FM"


def test_cw_is_limited_to_cw_subbands():
    assert _classify(144_050_000) == "CW"
    assert _classify(432_050_000) == "CW"
    assert _classify(144_200_000) is None


def test_pager_band_still_routes_to_fm_recorder_family():
    assert _classify(152_480_000) == "FM"


def test_empty_band_list_disables_that_recorder_family():
    fm = bandplan.parse_frequency_ranges("", bandplan.DEFAULT_FM_RECORD_BANDS)
    cw = bandplan.parse_frequency_ranges("", bandplan.DEFAULT_CW_RECORD_BANDS)
    assert fm == ()
    assert cw == ()
    assert bandplan.classify_peak_for_recording(
        146_940_000,
        fm_record_bands=fm,
        cw_record_bands=cw,
        acars_min_hz=128_000_000,
        acars_max_hz=132_000_000,
    ) is None


def test_frequency_range_parser_accepts_mhz_shorthand():
    assert bandplan.parse_frequency_ranges("144.3MHz-148MHz,420-450", "") == (
        (144_300_000, 148_000_000),
        (420_000_000, 450_000_000),
    )
