# SDR watchdog

A small Kubernetes auto-recovery supervisor for the sdr-research stack. It runs
as a single-replica Deployment in the same namespace as the decoders and, once
per cycle, polls the API's `/api/v1/admin/radio-status` endpoint and walks a
per-radio escalation state machine:

```
GREEN  → fresh data within threshold; clear any prior escalation
YELLOW → just went stale; wait one cycle (transient)
ORANGE → stale beyond restart threshold; rollout-restart the decoder Deployment
RED    → still stale after restart; fire a webhook alert and back off
```

Escalation state is persisted in a ConfigMap (`sdr-watchdog-state` by default)
so that restarting the watchdog itself does not reset the counters. Hardware
outages (USB device gone, dongle dead, passthrough lost) are treated as
un-recoverable from software: after a failed restart the radio escalates
straight to RED so an operator gets paged instead of cycling pods forever.

## How it recovers a decoder

A "rollout restart" is performed exactly the way `kubectl rollout restart` does
it — by patching a `sdr-watchdog/restartedAt` annotation onto the Deployment's
pod template, which causes Kubernetes to roll the pods. The watchdog only
patches Deployments whose `spec.replicas > 0`, so decoders that are
intentionally scaled to zero are skipped.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WATCHDOG_NAMESPACE` | `sdr-research` | Namespace the watchdog operates in (state ConfigMap + watched Deployments). |
| `WATCHDOG_API_URL` | `http://sdr-viewer-api.sdr-research.svc.cluster.local:8000/api/v1/admin/radio-status` | API radio-status endpoint to poll. |
| `WATCHDOG_STATE_CM` | `sdr-watchdog-state` | Name of the ConfigMap used to persist escalation state. |
| `WATCHDOG_CYCLE_SECONDS` | `60` | Seconds between decision cycles. |
| `WATCHDOG_RESTART_GRACE_SECONDS` | `600` | Minimum wait after an ORANGE restart before escalating to RED (avoids paging a slow-starting decoder). |
| `ALERT_WEBHOOK_URL` | _(empty)_ | Webhook to POST critical alerts to. If unset, alerts are logged only. |
| `WATCHDOG_DRY_RUN` | _(empty)_ | Set to `1`/`true`/`yes` to log intended restarts without actually patching Deployments. |

No webhook URL, hostname, or credential is baked into the image — the API URL
above is only a default and the webhook URL is supplied entirely via env.

## Watched radios / Deployments

The set of radios and the Deployment each one restarts is currently defined in
the `RADIOS` list near the top of `watchdog.py`. Each entry maps an API source
name to a Deployment name plus freshness/restart/alert thresholds. The default
build watches these Deployments:

- `unified-sdr` (source `airspy-2m`)
- `unified-sdr-70cm` (source `rtl-70cm`)
- `ft8-wspr-decoder` (source `spots-ft8`)

These Deployment names are hardcoded today; making `RADIOS` configurable (env
or mounted config) is a reasonable future enhancement.

## RBAC

The watchdog needs a ServiceAccount bound to a namespaced Role with the
following rules:

- `apps` / `deployments`, `daemonsets`: `get`, `list`, `watch` — read desired
  replica counts.
- `apps` / `deployments`: `patch`, `update` — perform the rollout restart.
- `""` (core) / `pods`: `get`, `list`, `watch` — read pod state for diagnostics.
- `""` (core) / `configmaps`: `get`, `list`, `watch`, `create`, `patch`,
  `update` — read and persist the watchdog's own state ConfigMap (it creates
  the ConfigMap on first run if it does not already exist).

A single namespaced Role + RoleBinding is sufficient; no cluster-wide
permissions are required.

## Build

```sh
docker build -t sdr-research-watchdog .
```

The image is pure Python (the only dependency is the `kubernetes` client), so
it builds for both `linux/amd64` and `linux/arm64` with no platform-specific
caveats.
