"""
Offline tests for RepeaterBook access controls. No network: urllib's urlopen
is replaced with a fake that records every request and replays canned
responses. Sync state lives in a temp-file SQLite DB; a "restart" is
simulated by building a fresh session factory against the same file.

Controls under test:
  * auth / authorization / scope / User-Agent denials stop the whole batch
    and block every later trigger (startup, scheduled, manual) until an
    operator clears the block;
  * HTTP 429 honors Retry-After and the backoff survives repeated triggers
    and restarts;
  * any other HTTP error aborts the batch instead of moving to the next state.
"""

import io
import json
from datetime import datetime, timedelta
from urllib import error

import pytest
from app.database import Base
from app.models import Repeater, RepeaterBookSyncState
from app.services import repeater
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

T0 = datetime(2026, 10, 23, 3, 0, 0)
STATES = "OH,IN,KY"
STATION = (39.49, -84.31)
OK_BODY = {
    "ok": True,
    "results": [{"Callsign": "W8ABC", "Frequency": "146.940", "State": "Ohio", "Lat": "39.50", "Long": "-84.30"}],
}


class FakeNet:
    """Stands in for urllib.request.urlopen."""

    def __init__(self):
        self.requests = []
        self.responses = []  # queue of callables / dicts; last one repeats

    def queue(self, *responses):
        self.responses.extend(responses)

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        resp = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(resp, Exception):
            raise resp
        return io.BytesIO(json.dumps(resp).encode())


def http_error(code, body=None, headers=None):
    payload = json.dumps(body or {}).encode()
    return error.HTTPError("https://example.invalid", code, "err", headers or {}, io.BytesIO(payload))


UA_BANNED = lambda: http_error(
    403, {"ok": False, "error_code": "ua_banned", "message": "This User-Agent has been blocked due to abuse."}
)


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_file = tmp_path / "state.db"

    def boot():
        """Fresh engine + session factory on the same DB file == API restart."""
        engine = create_engine(f"sqlite:///{db_file}")
        # Only the tables this service touches; others use Postgres-only types.
        Base.metadata.create_all(
            bind=engine, tables=[Repeater.__table__, RepeaterBookSyncState.__table__]
        )
        monkeypatch.setattr(repeater, "SessionLocal", sessionmaker(bind=engine))

    boot()
    net = FakeNet()
    clock = {"now": T0}
    monkeypatch.setattr(repeater.request, "urlopen", net)
    monkeypatch.setattr(repeater, "_utcnow", lambda: clock["now"])
    monkeypatch.setattr(repeater.settings, "repeaterbook_enabled", True)
    monkeypatch.setattr(repeater.settings, "repeaterbook_states", STATES)
    monkeypatch.setattr(repeater.settings, "repeaterbook_sync_hours", 24)
    monkeypatch.setattr(repeater.settings, "repeaterbook_latitude", STATION[0])
    monkeypatch.setattr(repeater.settings, "repeaterbook_longitude", STATION[1])
    monkeypatch.setattr(repeater.settings, "repeaterbook_radius_miles", 75)

    class Env:
        pass

    e = Env()
    e.net, e.clock, e.restart = net, clock, boot

    def advance(**kw):
        clock["now"] += timedelta(**kw)

    e.advance = advance
    return e


def all_triggers(env):
    """Fire every trigger kind, including a restart, and return the results."""
    out = [repeater.sync_repeaters("scheduled"), repeater.sync_repeaters("manual")]
    env.restart()
    out.append(repeater.sync_repeaters("startup"))
    return out


# --- denials -----------------------------------------------------------------

def test_ua_banned_stops_entire_batch(env):
    env.net.queue(UA_BANNED())
    result = repeater.sync_repeaters("startup")
    assert result["status"] == "blocked"
    assert len(env.net.requests) == 1, "must not continue to IN / KY after a denial"


@pytest.mark.parametrize(
    "denial",
    [
        lambda: http_error(401, {"ok": False, "error_code": "auth_missing"}),
        lambda: http_error(403, {"ok": False, "error_code": "scope_denied"}),
        lambda: http_error(403, None),
        # Denial reported in a 200 body
        lambda: {"ok": False, "error_code": "token_revoked"},
    ],
    ids=["401-auth", "403-scope", "403-no-body", "200-ok-false"],
)
def test_every_denial_kind_blocks(env, denial):
    env.net.queue(denial())
    assert repeater.sync_repeaters("scheduled")["status"] == "blocked"
    assert len(env.net.requests) == 1
    assert repeater.repeaterbook_status()["blocked"] is True


def test_block_prevents_scheduled_manual_and_startup_retries_across_restarts(env):
    env.net.queue(UA_BANNED())
    repeater.sync_repeaters("startup")
    assert len(env.net.requests) == 1

    # A week of nightly ticks, manual clicks and pod restarts: zero requests.
    env.net.queue(OK_BODY)
    for _ in range(7):
        env.advance(days=1)
        results = all_triggers(env)
        assert all(r["status"] == "skipped" for r in results), results
        assert all("blocked" in r["reason"] for r in results)
    assert len(env.net.requests) == 1


def test_block_only_lifts_after_operator_clear(env):
    env.net.queue(UA_BANNED())
    repeater.sync_repeaters("startup")
    env.advance(days=2)
    assert repeater.sync_repeaters("manual")["status"] == "skipped"

    env.net.responses = [OK_BODY]
    assert repeater.clear_repeaterbook_block("test-operator") == {"cleared": True}
    result = repeater.sync_repeaters("manual")
    assert result["status"] == "ok"
    assert len(env.net.requests) == 1 + 3  # one denied + three states after clear


def test_user_agent_is_not_altered(env, monkeypatch):
    monkeypatch.setenv("REPEATERBOOK_USER_AGENT", "registered-app/1.0 (op@example.com)")
    env.net.queue(UA_BANNED())
    repeater.sync_repeaters("startup")
    repeater.clear_repeaterbook_block("t")
    env.net.responses = [OK_BODY]
    repeater.sync_repeaters("manual")
    uas = {r.get_header("User-agent") for r in env.net.requests}
    assert uas == {"registered-app/1.0 (op@example.com)"}


# --- 429 / Retry-After -------------------------------------------------------

def test_429_honors_retry_after_seconds_across_triggers_and_restart(env):
    env.net.queue(http_error(429, {}, {"Retry-After": "7200"}), OK_BODY)
    result = repeater.sync_repeaters("startup")
    assert result["status"] == "rate_limited"
    assert len(env.net.requests) == 1, "429 must abort the batch"

    # Interval check aside, manual + restart within the window send nothing.
    env.advance(minutes=119)
    env.restart()
    assert repeater.sync_repeaters("manual")["status"] == "skipped"
    assert repeater.sync_repeaters("startup")["status"] == "skipped"
    assert len(env.net.requests) == 1

    env.advance(minutes=2)
    assert repeater.sync_repeaters("manual")["status"] == "ok"
    assert repeater.repeaterbook_status()["consecutive_rate_limits"] == 0


def test_429_honors_retry_after_http_date(env):
    when = T0 + timedelta(hours=5)
    env.net.queue(http_error(429, {}, {"Retry-After": when.strftime("%a, %d %b %Y %H:%M:%S GMT")}), OK_BODY)
    repeater.sync_repeaters("startup")
    assert repeater.repeaterbook_status()["backoff_until"] == when.isoformat()
    env.advance(hours=4, minutes=59)
    assert repeater.sync_repeaters("manual")["status"] == "skipped"
    env.advance(minutes=1)
    assert repeater.sync_repeaters("manual")["status"] == "ok"


def test_repeated_429_backoff_escalates_and_never_undercuts_retry_after(env):
    env.net.queue(http_error(429))  # no Retry-After, repeats
    expected = [1, 2, 4, 8]
    for hours in expected:
        assert repeater.sync_repeaters("manual")["status"] == "rate_limited"
        until = datetime.fromisoformat(repeater.repeaterbook_status()["backoff_until"])
        assert until - env.clock["now"] == timedelta(hours=hours)
        env.clock["now"] = until
    assert len(env.net.requests) == len(expected)

    # Server-specified wait longer than our exponential step wins.
    env.net.responses = [http_error(429, {}, {"Retry-After": str(3 * 86400)})]
    repeater.sync_repeaters("manual")
    until = datetime.fromisoformat(repeater.repeaterbook_status()["backoff_until"])
    assert until - env.clock["now"] == timedelta(days=3)


def test_503_with_retry_after_is_treated_as_backoff(env):
    env.net.queue(http_error(503, {}, {"Retry-After": "600"}))
    assert repeater.sync_repeaters("startup")["status"] == "rate_limited"


# --- other errors / scheduling ----------------------------------------------

def test_server_error_aborts_batch_without_permanent_block(env):
    env.net.queue(http_error(500), OK_BODY)
    assert repeater.sync_repeaters("startup")["status"] == "error"
    assert len(env.net.requests) == 1
    assert repeater.repeaterbook_status()["blocked"] is False
    # Not retried until the next scheduled interval.
    env.advance(hours=23)
    assert repeater.sync_repeaters("scheduled")["status"] == "skipped"
    env.advance(hours=1)
    assert repeater.sync_repeaters("scheduled")["status"] == "ok"


def test_restart_loop_does_not_retrigger_sync(env):
    env.net.queue(OK_BODY)
    assert repeater.sync_repeaters("startup")["status"] == "ok"
    for _ in range(20):  # crash-looping pod
        env.advance(minutes=5)
        env.restart()
        assert repeater.sync_repeaters("startup")["status"] == "skipped"
    assert len(env.net.requests) == 3


def test_attempt_recorded_before_request(env):
    def boom(req, timeout=None):
        # Process dies mid-fetch; the attempt must already be persisted.
        assert repeater.repeaterbook_status()["last_attempt_at"] == T0.isoformat()
        raise KeyboardInterrupt

    env.net.responses = [OK_BODY]
    repeater.request.urlopen = boom
    with pytest.raises(KeyboardInterrupt):
        repeater.sync_repeaters("startup")
    repeater.request.urlopen = env.net
    env.restart()
    assert repeater.sync_repeaters("startup")["status"] == "skipped"


def test_unreadable_state_fails_closed(env, monkeypatch):
    def broken():
        raise RuntimeError("db down")

    monkeypatch.setattr(repeater, "SessionLocal", broken)
    env.net.queue(OK_BODY)
    result = repeater.sync_repeaters("startup")
    assert result["status"] == "skipped"
    assert "state unavailable" in result["reason"]
    assert env.net.requests == []


def test_manual_endpoint_refuses_while_blocked(env):
    from app.main import app
    from fastapi.testclient import TestClient

    env.net.queue(UA_BANNED())
    repeater.sync_repeaters("startup")

    client = TestClient(app)
    resp = client.post("/api/v1/admin/sync-repeaters")
    assert resp.status_code == 409
    assert "blocked" in resp.json()["detail"]["reason"]

    resp = client.post("/api/v1/admin/repeaterbook/clear-block", json={"confirm": "yes"})
    assert resp.status_code == 400
    assert len(env.net.requests) == 1


# --- request shape and parsing -----------------------------------------------

def test_requests_use_fips_state_id(env):
    env.net.queue(OK_BODY)
    assert repeater.sync_repeaters("startup")["status"] == "ok"
    urls = [r.full_url for r in env.net.requests]
    assert urls == [
        "https://www.repeaterbook.com/api/export.php?state_id=39",
        "https://www.repeaterbook.com/api/export.php?state_id=18",
        "https://www.repeaterbook.com/api/export.php?state_id=21",
    ]


def test_unknown_state_aborts_before_any_request(env, monkeypatch):
    monkeypatch.setattr(repeater.settings, "repeaterbook_states", "ZZ,OH")
    env.net.queue(OK_BODY)
    assert repeater.sync_repeaters("startup")["status"] == "error"
    assert env.net.requests == []


def test_rows_parsed_and_filtered_by_radius(env):
    body = {
        "ok": True,
        "results": [
            {
                "Callsign": "w8abc", "Frequency": "146.940", "Input Freq": "146.340",
                "PL": "118.8", "Nearest City": "Dayton", "County": "Montgomery",
                "State": "Ohio", "Lat": "39.7589", "Long": "-84.1916", "Use": "OPEN",
                "DMR": "Yes", "APCO P-25": "Yes", "EchoLink Node": "12345",
            },
            # ~200 mi away: outside the 75 mi radius.
            {"Callsign": "K8FAR", "Frequency": "147.000", "Lat": "41.4993", "Long": "-81.6944"},
            # No coordinates: can't be placed or range-checked.
            {"Callsign": "K8NOLOC", "Frequency": "147.120", "Lat": "", "Long": ""},
        ],
    }
    env.net.queue(body)
    assert repeater.sync_repeaters("startup")["status"] == "ok"
    db = repeater.SessionLocal()
    try:
        rows = db.query(Repeater).all()
        assert [r.callsign for r in rows] == ["W8ABC"]
        r = rows[0]
        assert r.frequency_hz == pytest.approx(146_940_000)
        assert r.input_hz == pytest.approx(146_340_000)
        assert r.pl_tone == pytest.approx(118.8)
        assert (r.location, r.county, r.state) == ("Dayton", "Montgomery", "Ohio")
        assert (r.latitude, r.longitude) == (pytest.approx(39.7589), pytest.approx(-84.1916))
        assert r.digital_modes == "DMR,APCO P-25"
        assert r.linked_nodes == "EchoLink:12345"
    finally:
        db.close()
