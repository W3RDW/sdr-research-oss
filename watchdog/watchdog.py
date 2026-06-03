"""sdr-watchdog — auto-recovery loop for the sdr-research stack.

This service runs as a single-replica Deployment in the sdr-research namespace
and supervises the SDR data pipeline. Once a minute it polls the API's
/api/v1/admin/radio-status endpoint, compares each radio's freshness to a
configured threshold, and walks an escalation state machine per radio:

    GREEN  → fresh data within threshold; clear any prior escalation
    YELLOW → just went stale; wait one cycle (transient)
    ORANGE → stale beyond restart threshold; rollout-restart the deployment
    RED    → still stale after restart; fire webhook alert and back off

State is persisted in a ConfigMap (sdr-watchdog-state) so that restarting the
watchdog itself does not reset escalation counters. Hardware-level outages
(USB device gone, dongle dead, VMware passthrough lost) are explicitly
recognised as un-recoverable from software: after the first failed restart we
escalate straight to RED so the operator gets paged instead of cycling pods
forever.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

from kubernetes import client, config


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

NAMESPACE = os.environ.get("WATCHDOG_NAMESPACE", "sdr-research")
API_URL = os.environ.get(
    "WATCHDOG_API_URL",
    "http://sdr-viewer-api.sdr-research.svc.cluster.local:8000/api/v1/admin/radio-status",
)
STATE_CONFIGMAP = os.environ.get("WATCHDOG_STATE_CM", "sdr-watchdog-state")
CYCLE_SECONDS = int(os.environ.get("WATCHDOG_CYCLE_SECONDS", "60"))
ALERT_WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL", "").strip()
DRY_RUN = os.environ.get("WATCHDOG_DRY_RUN", "").lower() in ("1", "true", "yes")

# After ORANGE-stage restart we wait at least this long before escalating to
# RED, so we don't paint a slow-starting decoder as a hardware failure.
RESTART_GRACE_SECONDS = int(os.environ.get("WATCHDOG_RESTART_GRACE_SECONDS", "600"))

# Per-radio rules. `source` matches the API's source name; `kind` selects
# whether the freshness number comes from the recordings or spots table.
# `deployment` is what we rollout-restart on ORANGE; daemonset is unused for
# now (USB reset is a future enhancement) but recorded for the alert payload.
#
# stale_after: how long without data before we even consider acting
# restart_after: total stale time before we rollout-restart the deployment
# alert_after_actions: how many failed restart attempts before paging
RADIOS: list[dict[str, Any]] = [
    {
        "name": "airspy-2m",
        "source": "airspy-2m",
        "kind": "recording",
        "deployment": "unified-sdr",
        "daemonset": None,
        "stale_after": 600,         # 10 min — 2m is busy
        "restart_after": 1800,      # 30 min stale → rollout restart
        "alert_after_actions": 2,
    },
    {
        "name": "rtl-70cm",
        "source": "rtl-70cm",
        "kind": "recording",
        "deployment": "unified-sdr-70cm",
        "daemonset": "rtl-sdr-tcp-70cm",
        "stale_after": 1800,        # 70cm is sparse
        "restart_after": 3600,      # 1h stale → restart
        "alert_after_actions": 1,   # one failed restart → it's hardware
    },
    {
        "name": "ft8-wspr",
        "source": "spots-ft8",
        "kind": "spot",
        "deployment": "ft8-wspr-decoder",
        "daemonset": None,
        "stale_after": 1200,        # 20 min — band cycling + WSPR slots
        "restart_after": 3600,
        "alert_after_actions": 2,
    },
]

STAGE_GREEN = "green"
STAGE_YELLOW = "yellow"
STAGE_ORANGE = "orange"
STAGE_RED = "red"


# ---------------------------------------------------------------------------
# Kubernetes / state helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_ts() -> float:
    return time.time()


def _load_kube() -> tuple[client.AppsV1Api, client.CoreV1Api]:
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    return client.AppsV1Api(), client.CoreV1Api()


def _load_state(core: client.CoreV1Api) -> dict[str, dict[str, Any]]:
    """Read state ConfigMap; create empty one if missing."""
    try:
        cm = core.read_namespaced_config_map(STATE_CONFIGMAP, NAMESPACE)
    except client.ApiException as e:
        if e.status != 404:
            raise
        body = client.V1ConfigMap(
            metadata=client.V1ObjectMeta(name=STATE_CONFIGMAP, namespace=NAMESPACE),
            data={"state.json": "{}"},
        )
        cm = core.create_namespaced_config_map(NAMESPACE, body)
    raw = (cm.data or {}).get("state.json", "{}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def _save_state(core: client.CoreV1Api, state: dict[str, dict[str, Any]]) -> None:
    body = {"data": {"state.json": json.dumps(state, indent=2, sort_keys=True)}}
    core.patch_namespaced_config_map(STATE_CONFIGMAP, NAMESPACE, body)


def _fetch_radio_status() -> Optional[list[dict[str, Any]]]:
    try:
        with urllib.request.urlopen(API_URL, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"[watchdog] could not fetch radio-status: {exc}", flush=True)
        return None
    return payload.get("radios", [])


def _rollout_restart(apps: client.AppsV1Api, deployment: str) -> bool:
    """Trigger a rollout restart by patching the pod template annotation."""
    if DRY_RUN:
        print(f"[watchdog] DRY_RUN: would restart deploy/{deployment}", flush=True)
        return True
    body = {
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "sdr-watchdog/restartedAt": _now_iso(),
                    }
                }
            }
        }
    }
    try:
        apps.patch_namespaced_deployment(deployment, NAMESPACE, body)
        print(f"[watchdog] rollout restarted deploy/{deployment}", flush=True)
        return True
    except client.ApiException as exc:
        print(f"[watchdog] failed to restart deploy/{deployment}: {exc}", flush=True)
        return False


def _send_alert(payload: dict[str, Any]) -> None:
    if not ALERT_WEBHOOK_URL:
        print(f"[watchdog] (no webhook configured) alert: {json.dumps(payload)}", flush=True)
        return
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ALERT_WEBHOOK_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
        print(f"[watchdog] alert delivered: {payload.get('summary')}", flush=True)
    except urllib.error.URLError as exc:
        print(f"[watchdog] alert delivery failed: {exc}", flush=True)


def _deployment_is_desired(apps: client.AppsV1Api, deployment: str) -> bool:
    """Skip radios whose deployment is intentionally scaled to zero."""
    try:
        d = apps.read_namespaced_deployment(deployment, NAMESPACE)
    except client.ApiException:
        return False
    return (d.spec.replicas or 0) > 0


# ---------------------------------------------------------------------------
# State machine
# ---------------------------------------------------------------------------

def _radio_state(state: dict[str, Any], name: str) -> dict[str, Any]:
    return state.setdefault(name, {
        "stage": STAGE_GREEN,
        "since_ts": 0.0,
        "last_action_ts": 0.0,
        "action_count": 0,
        "last_alert_ts": 0.0,
    })


def _evaluate_radio(
    radio: dict[str, Any],
    radio_status: dict[str, Any],
    radio_state: dict[str, Any],
    apps: client.AppsV1Api,
) -> dict[str, Any]:
    """Run one decision cycle for a single radio. Mutates radio_state in place."""
    last_seen = radio_status.get("last_seen_seconds")
    now = _now_ts()
    name = radio["name"]
    stage = radio_state["stage"]

    if last_seen is None:
        # No data ever seen — treat as max staleness so the state machine
        # behaves the same as a long outage.
        last_seen = 10**9

    # GREEN — fresh
    if last_seen < radio["stale_after"]:
        if stage != STAGE_GREEN:
            print(f"[watchdog] {name}: recovered (last_seen={last_seen}s) → GREEN", flush=True)
        radio_state.update(
            stage=STAGE_GREEN, since_ts=0.0, action_count=0,
            last_action_ts=0.0, last_alert_ts=0.0,
        )
        return radio_state

    # YELLOW — just stale, give it one cycle
    if last_seen < radio["restart_after"]:
        if stage == STAGE_GREEN:
            print(f"[watchdog] {name}: gone stale (last_seen={last_seen}s) → YELLOW", flush=True)
            radio_state.update(stage=STAGE_YELLOW, since_ts=now)
        return radio_state

    # ORANGE — stale long enough to act
    actions = radio_state.get("action_count", 0)
    if stage in (STAGE_GREEN, STAGE_YELLOW) or (
        stage == STAGE_ORANGE and now - radio_state.get("last_action_ts", 0) > RESTART_GRACE_SECONDS
    ):
        if actions >= radio["alert_after_actions"]:
            # Skip restart, go straight to RED — restart attempts have not
            # brought it back, so this is almost certainly hardware. Don't
            # cycle the pod forever.
            return _enter_red(radio, radio_status, radio_state, last_seen)

        deployment = radio["deployment"]
        if not _deployment_is_desired(apps, deployment):
            print(f"[watchdog] {name}: deploy/{deployment} replicas=0, skipping", flush=True)
            radio_state.update(stage=STAGE_GREEN, since_ts=0.0, action_count=0)
            return radio_state

        print(
            f"[watchdog] {name}: stale {last_seen}s ≥ {radio['restart_after']}s — "
            f"restarting deploy/{deployment} (attempt {actions + 1}/{radio['alert_after_actions']})",
            flush=True,
        )
        ok = _rollout_restart(apps, deployment)
        radio_state.update(
            stage=STAGE_ORANGE,
            since_ts=radio_state.get("since_ts") or now,
            last_action_ts=now,
            action_count=actions + 1,
        )
        if not ok:
            # API call failed; escalate immediately so we don't silently fail.
            return _enter_red(radio, radio_status, radio_state, last_seen)
        return radio_state

    # ORANGE but still inside grace period — wait
    return radio_state


def _enter_red(
    radio: dict[str, Any],
    radio_status: dict[str, Any],
    radio_state: dict[str, Any],
    last_seen: int,
) -> dict[str, Any]:
    """Fire alert and stop touching the radio until it recovers on its own."""
    now = _now_ts()
    if radio_state.get("stage") == STAGE_RED and now - radio_state.get("last_alert_ts", 0) < 3600:
        # Already alerted in the last hour, don't spam
        return radio_state
    summary = (
        f"SDR radio '{radio['name']}' is stale ({last_seen}s, no data) — "
        f"{radio_state.get('action_count', 0)} restart attempt(s) failed. "
        f"Likely hardware: check USB / passthrough / dongle on the host."
    )
    print(f"[watchdog] {radio['name']}: → RED  {summary}", flush=True)
    _send_alert({
        "summary": summary,
        "kind": "sdr-watchdog",
        "severity": "critical",
        "radio": radio["name"],
        "deployment": radio.get("deployment"),
        "daemonset": radio.get("daemonset"),
        "last_seen_seconds": last_seen,
        "last_seen_at": radio_status.get("last_seen_at"),
        "restart_attempts": radio_state.get("action_count", 0),
        "ts": _now_iso(),
    })
    radio_state.update(stage=STAGE_RED, last_alert_ts=now)
    return radio_state


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def _heartbeat() -> None:
    try:
        with open("/tmp/watchdog_heartbeat", "w") as f:
            f.write(str(_now_ts()))
    except OSError:
        pass


def main() -> int:
    print(
        f"[watchdog] starting; namespace={NAMESPACE} cycle={CYCLE_SECONDS}s "
        f"dry_run={DRY_RUN} radios={[r['name'] for r in RADIOS]}",
        flush=True,
    )
    apps, core = _load_kube()
    while True:
        _heartbeat()
        try:
            state = _load_state(core)
            radios = _fetch_radio_status()
            if radios is None:
                # API unreachable — don't escalate, the watchdog itself
                # depends on the API which has its own restart loop.
                time.sleep(CYCLE_SECONDS)
                continue
            by_source = {r["source"]: r for r in radios}
            for radio in RADIOS:
                status = by_source.get(radio["source"], {
                    "source": radio["source"], "last_seen_seconds": None,
                })
                rs = _radio_state(state, radio["name"])
                _evaluate_radio(radio, status, rs, apps)
            _save_state(core, state)
        except Exception:
            print("[watchdog] cycle error:", flush=True)
            traceback.print_exc()
        time.sleep(CYCLE_SECONDS)


if __name__ == "__main__":
    sys.exit(main() or 0)
