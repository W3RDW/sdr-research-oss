# Ollama tagging setup

The API can POST every voice transcript to a local [Ollama](https://ollama.com)
instance for topic / intent / sentiment tagging. Tags get stored on the
recording row and surface in the UI's filter sidebar and search.

This is **completely optional**. If you don't enable it, recordings still get
basic tags from the transcript (callsign matches, frequency hints).

## How it works

1. Indexer finds a new voice recording with a transcript.
2. Builds a prompt: transcript + frequency_label + repeater info + station context.
3. POSTs to `${OLLAMA_URL}/api/generate` using `${OLLAMA_MODEL}`.
4. Parses the response into ≤`OLLAMA_MAX_TAGS` short tags.
5. Persists them on the recording.

Built-in safety:
- **Per-cycle cap** (`OLLAMA_MAX_PER_CYCLE=40`) — prevents runaway when many
  new recordings land at once (e.g. after a backfill).
- **Timeout** (`OLLAMA_TIMEOUT_SECONDS=20`) — slow GPU / overloaded server
  won't stall the indexer.
- **Circuit breaker** — 3 consecutive failures opens the breaker for 5
  minutes; calls skip until it closes. Counts surface in Prometheus
  (`indexer_ollama_calls`, `indexer_ollama_errors`).

## Pick a model

Ollama runs any model in their library. Tested with this stack:

| Model | Size | Notes |
|---|---|---|
| `llama3.1:8b` | 4.7 GB | Default. Great quality. ~2-4s per call on a modern GPU. |
| `llama3.2:3b` | 2 GB | Faster. Slightly less coherent tagging. |
| `qwen2.5:3b` | 1.9 GB | Smallest viable. Good for CPU-only setups. |
| `phi3:mini` | 2.3 GB | Microsoft's small model. Fine for short transcripts. |
| `mistral:7b` | 4.1 GB | Solid alternative to llama3.1. |

For CPU-only, stick with 3B-class models or expect 10-30s per call.

## Setup options

### Option A — Docker Compose (same host as the stack)

Uncomment the `ollama:` block in `deploy/docker-compose/docker-compose.yml`,
then:

```bash
cd deploy/docker-compose
docker compose up -d ollama
docker compose exec ollama ollama pull llama3.1:8b
# Set OLLAMA_ENABLED=true in .env, then:
docker compose up -d api
```

For NVIDIA GPU, also uncomment the `deploy.resources.reservations.devices`
block and ensure `nvidia-container-toolkit` is installed on the host.

Verify:

```bash
curl -s http://localhost:11434/api/tags | jq
docker compose logs api | grep -i ollama
```

### Option B — Existing Ollama (anywhere on the network)

If you already run Ollama (e.g. on a workstation with a GPU, on a separate
server, or via the macOS app), point the stack at it:

```dotenv
OLLAMA_ENABLED=true
OLLAMA_URL=http://192.168.1.50:11434
OLLAMA_MODEL=llama3.1:8b
```

Make sure your existing Ollama is reachable from the api container's
network. Default Ollama only binds `localhost` — to expose on LAN:

```bash
# systemd: edit /etc/systemd/system/ollama.service.d/override.conf
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"

# macOS app: launchctl setenv OLLAMA_HOST 0.0.0.0:11434
# Docker:   pass -e OLLAMA_HOST=0.0.0.0
```

Then pull the model on that host:

```bash
ollama pull llama3.1:8b
```

### Option C — Helm (existing in-cluster Ollama)

The Helm chart does **not** install Ollama itself (intentional — most
people already have one, and GPU scheduling is cluster-specific). Point
the chart at an existing service:

```yaml
# my-values.yaml
ollama:
  enabled: true
  url: "http://ollama.ollama.svc.cluster.local:11434"
  model: "llama3.1:8b"
  maxPerCycle: 40
```

```bash
helm upgrade sdr ./deploy/helm/sdr-research -f my-values.yaml
```

Popular Helm charts to install Ollama itself:
- [otwld/ollama-helm](https://github.com/otwld/ollama-helm) — community chart
- Roll your own — it's a single Deployment + Service + PVC.

## Tuning

After enabling, watch the metrics:

```bash
curl -s http://api:8000/metrics | grep ollama
# indexer_ollama_calls 142
# indexer_ollama_errors 0
```

If errors > 0:
- **Timeout?** Bump `OLLAMA_TIMEOUT_SECONDS` (especially CPU-only setups).
- **Connection refused?** Check `OLLAMA_URL` and that Ollama binds 0.0.0.0.
- **Model not found?** `ollama pull <model>` on the Ollama host.

If calls are too noisy / spending too much GPU:
- Lower `OLLAMA_MAX_PER_CYCLE` to throttle.
- Use a smaller model.

If tags are low-quality:
- Switch to a larger model (`llama3.1:70b` if you have the VRAM).
- Tweak the prompt — see `build_ollama_prompt()` in
  `api/app/services/indexer.py`.

## Disabling

```dotenv
OLLAMA_ENABLED=false
```

Existing tags persist. New recordings just won't get LLM tags. You can
re-tag later from the admin UI (`/admin` → "Re-tag selected").

## Cost

$0. Everything runs locally. No API keys, no rate limits, no data leaves
your network.
