# Publishing checklist

Things to do once per repo / per release.

## Make GHCR packages public (one-time)

By default GHCR creates packages as **private**. To let anyone `docker pull`
without auth, mark each package public:

### Option A — Web UI (~30 seconds)

1. Visit <https://github.com/orgs/w3rdw/packages>
2. Click each `sdr-research-*` package
3. **Package settings** → **Danger Zone** → **Change visibility** → `Public`

### Option B — gh CLI (after refreshing scopes)

```bash
gh auth refresh -h github.com -s admin:packages
for pkg in api ui unified-sdr aprs cw voice pager eas sstv spectrum-exporter; do
  gh api -X PATCH "/orgs/w3rdw/packages/container/sdr-research-$pkg/visibility" -f visibility=public
done
```

### Option C — Connect to the source repo (recommended)

GHCR packages can inherit visibility from a linked repo. The CI workflow already
adds `org.opencontainers.image.source` labels, so:

1. Visit each package's settings page
2. **Manage Actions access** → confirm `sdr-research-oss` repo is linked
3. **Inherit access from source repository** → enabled

Then if the repo is public, the packages are public. Future tags inherit
without per-package action.

## Cutting a release

```bash
# 1. Make sure main is green
gh run list --branch main --limit 5

# 2. Tag
git tag -a v0.X.Y -m "v0.X.Y — short description"
git push origin v0.X.Y

# 3. CI auto-builds and pushes images with tags:
#    ghcr.io/w3rdw/sdr-research-<name>:0.X.Y
#    ghcr.io/w3rdw/sdr-research-<name>:0.X
#    ghcr.io/w3rdw/sdr-research-<name>:latest
#    ghcr.io/w3rdw/sdr-research-<name>:sha-<7-char>

# 4. Bump Helm chart version
$EDITOR deploy/helm/sdr-research/Chart.yaml   # version: 0.X.Y, appVersion: "0.X.Y"

# 5. Bump default tags in values.yaml decoders.* if you want decoder versions
#    to track the chart (most users will pin via -f my-values.yaml anyway)

# 6. Optional: create a GitHub release with notes
gh release create v0.X.Y --generate-notes
```
