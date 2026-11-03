"""Frequency stats must not process millions of identical APRS tag sets."""
from collections import Counter
from fastapi import Response
from app.routers import stats


def test_grouped_tags_preserve_packet_counts_and_legacy_json():
    rows = [(["W8BLV", "voice"], 5), ('["W8BLV", "K8ABC"]', 9), ([], 100), (None, 2)]
    assert stats._count_grouped_tags(rows) == Counter(W8BLV=14, K8ABC=9, voice=5)
    assert stats._count_grouped_tags(rows, callsigns_only=True) == Counter(W8BLV=14, K8ABC=9)


def test_frequency_cache_respects_tolerance_and_expiration(monkeypatch):
    stats._frequency_cache.clear()
    clock = [100.0]
    monkeypatch.setattr(stats.time, "monotonic", lambda: clock[0])
    calls = []

    def compute(frequency, tolerance, db):
        calls.append((frequency, tolerance))
        return {"recordings_total": 0, "tolerance_hz": tolerance}

    monkeypatch.setattr(stats, "_compute_frequency_stats", compute)
    first = stats.get_frequency_stats(146610000, Response(), 10000, None)
    assert stats.get_frequency_stats(146610000, Response(), 10000, None) == first
    assert len(calls) == 1  # Cache empty frequency results too.
    stats.get_frequency_stats(146610000, Response(), 20000, None)
    assert len(calls) == 2
    clock[0] += 61
    stats.get_frequency_stats(146610000, Response(), 10000, None)
    assert len(calls) == 3
    stats._frequency_cache.clear()


def test_frequency_cache_is_bounded():
    stats._frequency_cache.clear()
    for i in range(stats._FREQUENCY_CACHE_LIMIT + 5):
        stats._store_frequency_stats((i, 10000), {"frequency_hz": i})
    assert len(stats._frequency_cache) == stats._FREQUENCY_CACHE_LIMIT
    assert stats._cached_frequency_stats((0, 10000)) is None
    assert stats._cached_frequency_stats((132, 10000)) == {"frequency_hz": 132}
    stats._frequency_cache.clear()
