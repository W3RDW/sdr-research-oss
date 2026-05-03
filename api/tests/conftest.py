"""
Shared pytest fixtures.

Tests run against an in-memory SQLite via the standard `database_url` env
override — no postgres required.
"""

import os
import sys
import pathlib

# Tests live in api/tests/ and import from api/app/. Make `app` importable.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

# Default to sqlite for tests so CI doesn't need postgres
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("CACHE_PATH", "/tmp/sdr-test-cache")
os.environ.setdefault("TEXT_BASE_PATH", "/tmp/sdr-test-data/text")
os.environ.setdefault("HF_TEXT_BASE_PATH", "/tmp/sdr-test-data/hf/text")
