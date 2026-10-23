# RepeaterBook setup

The RepeaterBook integration matches each recording's frequency to a known
repeater (callsign, location, modes, linked nodes) so the UI can show
"this was on the K8XYZ repeater in Cincinnati" instead of just "146.94 MHz".

## 1. Get an API token

1. Sign up / log in at <https://www.repeaterbook.com>.
2. Visit <https://www.repeaterbook.com/api/token_request.php>.
3. Fill in:
   - **App name** — anything, e.g. `sdr-research-oss-myhome`.
   - **App version** — `1.0`.
   - **Contact email** — your real email; they'll send the token here.
   - **User-Agent** — RepeaterBook will tell you the exact UA string they
     approved. Use it **verbatim** in the next step.
4. Wait for the approval email (usually fast, can take up to a day). The
   email contains your token (starts with `app_`) and the approved UA.

## 2. Configure

```dotenv
REPEATERBOOK_ENABLED=true
REPEATERBOOK_API_KEY=app_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
REPEATERBOOK_USER_AGENT=sdr-research-oss-myhome/1.0 (you@example.com)
REPEATERBOOK_EMAIL=you@example.com
REPEATERBOOK_LATITUDE=39.49
REPEATERBOOK_LONGITUDE=-84.30
REPEATERBOOK_RADIUS_MILES=75
REPEATERBOOK_STATES=OH,IN,KY    # nearby states
REPEATERBOOK_SYNC_HOURS=24
```

The User-Agent **must match** what RepeaterBook approved. Wrong UA → 401.

## 3. Restart the API

The API syncs on startup if one is due, then every `REPEATERBOOK_SYNC_HOURS`
(measured from the last *attempt*, which is persisted, so restarts do not
trigger extra syncs). Watch the logs:

```
[RepeaterBook] Syncing repeaters…
[RepeaterBook] OH: 1247 repeaters
[RepeaterBook] IN: 612 repeaters
[RepeaterBook] KY: 489 repeaters
[RepeaterBook] Upserted 2348 repeaters.
```

If you see `ACCESS DENIED (HTTP 401 auth_missing ...)`, your token or UA is
wrong. Double-check the approval email — see "Access denials" below.

## Access denials, rate limits and errors

The client fails closed. State lives in the `repeaterbook_sync_state` table,
so it survives restarts and applies to startup, scheduled and manual syncs.

| Response | Behavior |
|---|---|
| HTTP 401 / 403, or a body with `"ok": false` (e.g. `ua_banned`, auth, scope) | Whole batch stops immediately. **All** further syncs are blocked until an operator clears the block. |
| HTTP 429 (or 503 with `Retry-After`) | Batch stops. No request before `Retry-After`; without it, backoff starts at 1 h and doubles per consecutive 429 (max 7 days, never shorter than `Retry-After`). |
| Any other HTTP / network / parse error | Batch stops; retried at the next scheduled interval. |

Check state: `GET /api/v1/admin/repeaterbook/status`. While blocked or backing
off, `POST /api/v1/admin/sync-repeaters` returns `409`.

To clear a denial block — **only after the cause is fixed and RepeaterBook
has confirmed access** (never by changing the User-Agent, token or source to
get around a ban):

```bash
curl -X POST http://<api>/api/v1/admin/repeaterbook/clear-block \
  -H 'Content-Type: application/json' \
  -d '{"confirm": "cause corrected and access confirmed by RepeaterBook"}'
```

You can also set `REPEATERBOOK_ENABLED=false` to stop all RepeaterBook traffic.

## How matching works

- Recordings get matched within ±6 kHz of the repeater's output frequency
  (configurable via `FREQ_TOLERANCE_HZ` in `api/app/services/repeater.py`).
- Match takes the closest output frequency.
- Per-recording, the match populates `Recording.repeater_id`, which the UI
  uses to show callsign + location + linked nodes (EchoLink, IRLP, AllStar).
- Tags from the repeater (digital modes, linked-node prefixes) are added to
  the recording's `ai_tags` automatically.

## Privacy / rate limiting

RepeaterBook caches results — 24h sync interval is plenty for most use
cases. The API key is per-app and approved against your account; don't
share it.

The token has no expiry by default but RepeaterBook reserves the right to
revoke for misuse. Don't hammer the API.
