# Helm chart

Production-style deployment for Kubernetes.

## Quickstart

```bash
helm install sdr deploy/helm/sdr-research \
  --namespace sdr --create-namespace \
  --set station.callsign=YOUR-CALL \
  --set station.grid=AA00aa \
  --set unifiedSdr.osmosdrArgs="rtl_tcp=rtl-tcp:1234" \
  --set unifiedSdr.nodeSelector.kubernetes\\.io/hostname=sdr-host
```

## Required values to set

- `station.callsign` — your callsign (logbook + alerts)
- `station.{latitude,longitude,grid}` — used for distance calcs and APRS map
- `unifiedSdr.osmosdrArgs` — see `docs/hardware-matrix.md`
- `unifiedSdr.nodeSelector` — pin to the node with the SDR plugged in

## With external secrets

```bash
helm install sdr deploy/helm/sdr-research \
  --set repeaterbook.enabled=true \
  --set repeaterbook.existingSecret=my-rb-secret \
  --set alerts.enabled=true \
  --set alerts.existingSecret=my-alert-secret
```

The chart will read keys `repeaterbook-api-key` and `alert-webhook-url` from
the named secrets. Useful with `external-secrets` or `sops` workflows.

## With ingress

```yaml
ingress:
  enabled: true
  className: nginx
  host: sdr.example.com
  tls:
    enabled: true
    secretName: sdr-tls
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
```

## Decoders

Enable any combination — they all share the artifacts PVC with `unified-sdr`
and the API:

```yaml
decoders:
  aprs:              {enabled: true}
  cw:                {enabled: true}
  pager:             {enabled: true}
  eas:               {enabled: true}
  sstv:              {enabled: true}
  spectrum-exporter: {enabled: true}
  voice:
    enabled: true
    gpu: true                              # request nvidia.com/gpu: 1
    whisperModel: medium.en
    nodeSelector: {nvidia.com/gpu.present: "true"}
```

ACARS + VDL2 are not yet wired (apt packages don't exist in Debian). See
`decoders/{acars,vdl2}/README.md` for the source-build TODO.

Per-decoder, you can also override:
- `image.tag` to pin a specific version (default: matches chart appVersion)
- `nodeSelector` / `tolerations` to pin to specific nodes
- `resources` for CPU/memory limits
- `env` (map) for custom environment variables

## Uninstall

```bash
helm uninstall sdr -n sdr
kubectl delete pvc -n sdr -l app.kubernetes.io/name=sdr-research
# This deletes recordings + database. Back up first if you want to keep them.
```
