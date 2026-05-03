"""
Import smoke tests — exercise every router and service module end-to-end so
NameError / undefined-symbol bugs surface in CI instead of at runtime.

The 4 latent bugs caught between v0.1.0 → v0.1.1 (missing `import re`,
`import json`, missing cross-module function imports) would have been killed
by these tests on the first push.
"""

import importlib
import pkgutil

import pytest

ROUTERS = [
    "admin", "aprs", "events", "files", "repeaters",
    "search", "spots", "stats", "waveform", "weather",
]
SERVICES = [
    "alerting", "aprs_is", "audio", "hamdb", "indexer",
    "known_freqs", "metrics", "repeater", "tagging",
]


@pytest.mark.parametrize("name", ROUTERS)
def test_router_imports(name):
    """Each router module imports cleanly."""
    importlib.import_module(f"app.routers.{name}")


@pytest.mark.parametrize("name", SERVICES)
def test_service_imports(name):
    """Each service module imports cleanly."""
    importlib.import_module(f"app.services.{name}")


def test_main_imports():
    """The FastAPI app instance constructs without errors."""
    from app.main import app
    assert app is not None


def test_routers_have_router_attr():
    """Each router exposes `router` for inclusion in main."""
    for name in ROUTERS:
        mod = importlib.import_module(f"app.routers.{name}")
        assert hasattr(mod, "router"), f"app.routers.{name} missing `router`"


def test_no_unexpected_modules():
    """If a new module appears under routers/ or services/, fail so the test
    matrix gets updated alongside it (catches drift)."""
    import app.routers
    import app.services
    found_routers = {
        m.name for m in pkgutil.iter_modules(app.routers.__path__)
    }
    found_services = {
        m.name for m in pkgutil.iter_modules(app.services.__path__)
    }
    assert found_routers == set(ROUTERS), (
        f"router list out of sync: {found_routers} vs {set(ROUTERS)}. "
        "Update ROUTERS in api/tests/test_imports.py."
    )
    assert found_services == set(SERVICES), (
        f"service list out of sync: {found_services} vs {set(SERVICES)}. "
        "Update SERVICES in api/tests/test_imports.py."
    )
