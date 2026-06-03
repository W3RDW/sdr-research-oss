# MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server
that wraps the SDR Viewer HTTP API and exposes search/browse/stats tools to LLM
clients (e.g. Claude) over **streamable HTTP**. It is a thin
[FastMCP](https://github.com/modelcontextprotocol/python-sdk) proxy — it holds
no database of its own and only issues `GET` requests against the API.

## Tools

| Tool                  | API endpoint                          | What it does                                            |
| --------------------- | ------------------------------------- | ------------------------------------------------------- |
| `search_recordings`   | `/api/v1/search/text`                 | Full-text search over transcripts / CW decodes          |
| `browse_recordings`   | `/api/v1/files/browse`                | Filter recordings by mode, frequency, duration, callsign |
| `get_recording`       | `/api/v1/files/{id}`                  | Full detail for one recording                            |
| `list_repeaters`      | `/api/v1/repeaters`                   | Known repeaters (RepeaterBook sync)                      |
| `list_aprs_stations`  | `/api/v1/aprs/stations`               | APRS stations heard recently, latest position            |
| `list_aprs_packets`   | `/api/v1/aprs/packets`                | Decoded APRS packets, newest first                       |
| `station_stats`       | `/api/v1/stats`                       | Overall station statistics                               |
| `frequency_stats`     | `/api/v1/stats/frequency/{hz}`        | Activity stats for a specific frequency                  |
| `activity_heatmap`    | `/api/v1/stats/activity`              | Activity heatmap by hour-of-day / day-of-week            |
| `sdr_health`          | `/api/v1/admin/sdr-health`            | Per-band decoder / hardware health                       |
| `storage_status`      | `/api/v1/admin/storage`               | Recording/artifact storage usage                         |
| `recent_alerts`       | `/api/v1/admin/alerts`                | Recent fired alerts                                      |

## Environment variables

| Env var        | Default                          | Purpose                                                           |
| -------------- | -------------------------------- | ----------------------------------------------------------------- |
| `SDR_API_BASE` | `http://sdr-research-api:8000`   | Base URL of the SDR Viewer API. Default matches the Helm service. |
| `MCP_TOKEN`    | _(empty)_                        | Static bearer token. When set, every request to `/mcp` must send `Authorization: Bearer <token>`. When empty, auth is disabled (dev only). |

The server listens on **port 8080** and serves the MCP endpoint at `/mcp`. A
`/healthz` route returns `ok` and is always unauthenticated (used by the
liveness/readiness probes).

> Security note: leaving `MCP_TOKEN` empty disables auth entirely. Always set a
> token in any deployment reachable beyond localhost.

## Run locally

```sh
docker build -t sdr-research-mcp mcp
docker run --rm -p 8080:8080 \
  -e SDR_API_BASE=http://host.docker.internal:8000 \
  -e MCP_TOKEN=dev-token \
  sdr-research-mcp
```

Or without Docker:

```sh
pip install -r mcp/requirements.txt
SDR_API_BASE=http://localhost:8000 MCP_TOKEN=dev-token python mcp/server.py
```

## Pointing an MCP client at it

The endpoint is **streamable HTTP** at `http://<host>:8080/mcp`. Configure your
client with that URL and an `Authorization: Bearer <MCP_TOKEN>` header.

For a Claude Desktop / Claude Code style config using an HTTP MCP server:

```json
{
  "mcpServers": {
    "sdr-research": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer dev-token"
      }
    }
  }
}
```

Health check:

```sh
curl -s http://localhost:8080/healthz   # -> ok
```
