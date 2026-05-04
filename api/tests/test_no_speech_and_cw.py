"""
Regression tests for transcript hallucination detection and CW auto-delete.

Whisper given silent / near-silent audio commonly emits closing-banter
phrases learned from YouTube training data ("Thank you for watching",
"Please subscribe", etc). These tests cover the multi-sentence variants
that surface in production.

The CW auto-delete tests cover the 1-2s narrow-SSB-misclassified-as-CW
records where the decoder fails to extract Morse.
"""

import pytest


# ── No-speech / Whisper hallucination detection ───────────────────────────

@pytest.mark.parametrize("text", [
    # Empty / falsy
    "",
    None,
    # Original cases
    "[no speech detected]",
    "[BLANK_AUDIO]",
    "[blank audio]",
    "[recording too long for auto-transcribe]",
    "Thanks for watching!",
    "Thank you for watching",
    "Thank you for watching.",
    "Thanks for listening",
    "[music]",
    "[applause]",
    "you",
    "you.",
    "...",
    "***",
    # Multi-sentence Whisper hallucinations seen in production
    "Thank you for watching. Thanks for watching!",
    "Thanks for watching. Thanks for watching. Thanks for watching!",
    # Exact prod string from /player/770017 — newline-separated repeats
    "Thank you for watching.\nThank you for watching.",
    "Thank you for watching.\nThank you for watching.\n",
    "Thank you for listening. Goodbye.",
    "Bye! See you next time.",
    "Please like and subscribe!",
    "Thanks for watching! Don't forget to like and subscribe.",
    "Thank you. Bye.",
    "Thank you everyone for watching!",
    "Thanks so much for tuning in.",
])
def test_no_speech_hallucinations(text):
    from app.services.tagging import is_no_speech_transcript
    if text is None or text == "":
        assert is_no_speech_transcript(text) is False  # falsy = unknown, not hallucination
    else:
        assert is_no_speech_transcript(text) is True, f"failed: {text!r}"


@pytest.mark.parametrize("text", [
    "K1ABC clear",
    "Calling W1AW",
    "73 from K1ABC",
    "QRZ this is W1AW",
    "Repeater is up. Welcome to the net.",
    "Net control here. Anyone else?",
    # Real transcript that happens to contain hallucination-adjacent words
    "Thanks for the contact, K1ABC. 73.",
    "I'll see you on the next one.",  # has "see you" but real content
    "Bye for now, this is W1AW signing off",  # has "bye" but real content
])
def test_real_speech_not_flagged(text):
    from app.services.tagging import is_no_speech_transcript
    assert is_no_speech_transcript(text) is False, f"false positive on: {text!r}"


# ── CW auto-delete ─────────────────────────────────────────────────────────

# ── CW dots-only-noise callsign rejection ─────────────────────────────────

@pytest.mark.parametrize("noise_callsign", [
    # Real bogus "callsigns" pulled straight from production logbook,
    # all consisting only of Morse-dots-only chars (E/I/S/H/5) chunked from
    # decoded noise.
    "I5HEH", "IH5ESIH", "I5HIII", "I5HSI", "E5EH", "5E5I", "5I5EH",
    "S5SI", "IE5E", "H5IEEI", "E5SH", "HH5EIHI", "EI5I", "S5HIH",
    "5IS5HEH", "5IS5SH", "HE5S", "H5ESH", "I5SSH", "EE5HES", "EI5ISI",
    "S5HE", "S5HEE", "EI5SISI", "S5II", "EE5HE", "HI5HEH", "I5ISE",
    "HI5HEHH", "I5IS", "S5EH", "ES5SE", "I5EI", "E5HE", "EE5EES",
    "SH5I", "SI5HE", "EE5S", "E5ISI", "5EE5ISIS", "5I5EHH", "HH5I",
    "E5EE", "ES5I", "EI5S", "I5HEIE", "S5ISIS", "EE5H",
])
def test_cw_dots_noise_rejected(noise_callsign):
    from app.services.tagging import is_valid_callsign
    assert is_valid_callsign(noise_callsign) is False, (
        f"CW noise '{noise_callsign}' should be rejected as a callsign"
    )


@pytest.mark.parametrize("real_callsign", [
    # Real callsigns spanning prefix variety — none are dots-only
    "K1ABC", "W1AW", "N5XYZ", "AA0AA", "KE8WSC", "WB8AM", "K8XYZ",
    # International (lots of common prefixes)
    "G3ABC", "F5XYZ", "JA1ABC", "VE3ABC", "VK4ABC", "DL1ABC",
    # US callsigns that legitimately contain some dots-only chars but
    # also non-dot chars, so should pass
    "K5HISH",       # has K → non-dot
    "W1HEEL",       # has W → non-dot  (made up but structure-valid)
    "N5IEEE",       # has N → non-dot
])
def test_real_callsigns_still_valid(real_callsign):
    from app.services.tagging import is_valid_callsign
    assert is_valid_callsign(real_callsign) is True, (
        f"Real callsign '{real_callsign}' should pass validation"
    )


@pytest.mark.parametrize("mode,duration,transcript,expected", [
    # Should delete: short CW with failed/empty decode
    ("cw", 1.5, None, True),
    ("cw", 1.5, "", True),
    ("cw", 2.0, "[no decodable cw]", True),
    ("cw", 2.9, "[CW decode failed]", True),
    # Should keep: long CW (might be real even if decoder failed)
    ("cw", 5.0, None, False),
    ("cw", 10.0, "[no decodable cw]", False),
    # Should keep: CW with actual transcript
    ("cw", 1.5, "DE K1ABC", False),
    ("cw", 0.5, "QRZ", False),
    # Other modes: never delete via this path
    ("voice", 1.0, None, False),
    ("aprs", 0.5, "", False),
    ("pager", 1.0, None, False),
    # Edge: missing duration
    ("cw", None, None, False),
    # NEW: dot-only-Morse noise transcripts get deleted regardless of duration
    # Actual production transcripts pulled from the UI's "Similar Transcripts"
    ("cw", 60.0, "SEIS EES5EIIHEEIHESSEEEESEES ESEEE HIIIHEE I SIE5H55", True),
    ("cw", 30.0, "5EE5EEIIE5ESEIIIH HS ISH55E HIS 5IS55 ISS 5IEIIE5HEHI", True),
    ("cw", 120.0, "S EISEIISH5SS5 E5SEI5E I5IEISEIEEIEES5IISE", True),
    ("cw", 5.0, "ISS 5HE5 SS5HIISE5II ISEIHIEE55ES HSSI5IESS5EHS", True),
    ("cw", 2.0, "HS ISS ESI", True),
    ("cw", 10.0, "SEE55S ISSES", True),
    # Short legit Morse still kept (under noise-min-length threshold)
    ("cw", 1.0, "SOS", False),
    ("cw", 1.0, "HI HI", False),
    ("cw", 1.0, "EE", False),
    # Real CW with non-dots chars stays
    ("cw", 60.0, "DE K1ABC TU 73", False),
    ("cw", 30.0, "CQ CQ DE W1AW K", False),
])
def test_should_auto_delete_failed_cw(mode, duration, transcript, expected):
    from app.services.indexer import should_auto_delete_failed_cw
    assert should_auto_delete_failed_cw(mode, duration, transcript) is expected, \
        f"failed: mode={mode!r} dur={duration!r} txt={transcript!r}"
