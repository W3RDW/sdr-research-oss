"""Check CW timing without opening radio devices or importing decoder workers."""

import runpy
from pathlib import Path


def decoder():
    return runpy.run_path(str(Path(__file__).resolve().parents[2] / "decoders/cw/cw_decode.py"))


def test_dash_heavy_cq_has_sixty_ms_dits():
    ns = decoder()
    runs = []
    for letter in ("-.-.", "--.-"):
        for symbol in letter:
            runs.extend([(True, 181 if symbol == "-" else 61), (False, 59)])
        runs[-1] = (False, 179)
    dit = ns["estimate_dit_ms"](runs)
    assert dit == 61
    assert ns["decode_runs"](runs, dit) == "CQ"


def test_timing_requires_enough_key_elements():
    assert decoder()["estimate_dit_ms"]([(True, 60), (False, 180)]) is None


def test_fast_crackles_are_not_coerced_into_morse_timing():
    runs = [(True, duration) for duration in [5.125, 5.5, 6, 7, 8, 14, 16] * 3]
    assert decoder()["estimate_dit_ms"](runs) is None
