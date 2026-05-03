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

The API runs `sync_repeaters()` on startup, then every `REPEATERBOOK_SYNC_HOURS`.
Watch the logs:

```
[RepeaterBook] Syncing repeaters…
[RepeaterBook] OH: 1247 repeaters
[RepeaterBook] IN: 612 repeaters
[RepeaterBook] KY: 489 repeaters
[RepeaterBook] Upserted 2348 repeaters.
```

If you see `HTTP 401 for OH: {"error_code":"auth_missing"}`, your token or
UA is wrong. Double-check the approval email.

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
