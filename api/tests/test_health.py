"""
End-to-end smoke test of the FastAPI app via TestClient — no live server,
no postgres, no SDR. Boots the app in-process and hits /api/v1/health.
"""

from fastapi.testclient import TestClient


def test_health_ok():
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_openapi_renders():
    """If any route has a broken signature, openapi generation will throw."""
    from app.main import app
    client = TestClient(app)
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    spec = resp.json()
    assert "paths" in spec
    assert len(spec["paths"]) > 10  # we have many routes
