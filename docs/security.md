# Security

## Secrets handling

**Never commit secrets to the repo.** `.gitignore` excludes:
- `.env`, `.env.local`, `.env.*.local`
- `*.sops.yaml`, `*.age`, `age.key`
- `secrets/`

For Kubernetes deployments, use one of:

1. **Helm + existingSecret** — create the secret out-of-band:
   ```bash
   kubectl create secret generic my-sdr-secrets \
     --from-literal=repeaterbook-api-key=YOUR-KEY \
     --from-literal=alert-webhook-url=https://...
   helm install sdr ./deploy/helm/sdr-research \
     --set repeaterbook.existingSecret=my-sdr-secrets \
     --set alerts.existingSecret=my-sdr-secrets
   ```
2. **External Secrets Operator** — sync from 1Password / Vault / AWS Secrets Manager / etc.
3. **SOPS** — encrypt secrets with age, decrypt at apply time via ksops or sops-nix.
4. **Sealed Secrets** — bitnami's controller decrypts in-cluster.

Avoid `--set repeaterbook.apiKey=...` for production — values get logged.

## Network exposure

- The UI ships nginx with no auth. Don't expose to the public internet
  without a reverse proxy that adds authentication (Authentik, Authelia,
  oauth2-proxy, Cloudflare Access, etc.).
- The API has no built-in auth. Treat it the same.
- The Postgres pod has no `NetworkPolicy` by default — restrict via your
  CNI or by setting `postgres.service.type=ClusterIP` and adding a
  NetworkPolicy that only allows the api pod.

## Privileged containers

The `unified-sdr` container runs `privileged: true` for USB device access.
This is the same level of trust as installing a kernel module — only run
images you've built or that you trust the provenance of. The CI build is
reproducible; if you're paranoid, build from source.

## Reporting security issues

Please open a private security advisory on GitHub (Security → Advisories →
Report a vulnerability) for anything sensitive. For non-sensitive issues
(missing security headers, etc.), open a regular issue.
