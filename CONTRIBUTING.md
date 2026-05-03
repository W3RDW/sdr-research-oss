# Contributing

Thanks for considering a contribution. PRs welcome.

## Development setup

```bash
# Backend
cd api
pip install -e .
uvicorn app.main:app --reload

# Frontend
cd ui
npm install
npm run dev

# Database (separate terminal)
cd deploy/docker-compose
docker compose up postgres
```

## What's needed

See the [roadmap](README.md#status--roadmap). Top asks:

- **Decoder Helm sub-templates** — Helm chart only wires `unified-sdr`. Need
  templates for aprs/cw/voice/etc.
- **FT8/WSPR decoder script** — interface documented in
  `decoders/ft8-wspr/README.md`, implementation TBD.
- **Alembic migrations** — currently auto-creates tables, no upgrade path.
- **Tests** — there are essentially none. Pytest + Vitest.
- **More SDRs** — SDRplay, KiwiSDR, FunCube, etc. Per-device docs welcome.

## Code style

- Python: `ruff check api/`. No comments unless they explain *why* (not
  what). Type hints encouraged but not required.
- TypeScript: `npm run lint` in `ui/`. Strict mode is on.
- YAML: 2-space indent.

## Testing changes

- For UI: open the app in a browser, exercise the change.
- For API: `pytest api/tests/` (you'll have to write them — see "What's needed").
- For decoders: feed a known WAV and inspect the text output.
- For Helm: `helm template` + `helm lint`.

## Sending a PR

1. Fork → branch → commit.
2. Run lint locally.
3. Open the PR with a short "what + why" description.
4. CI must pass.

## License

By contributing, you agree your contribution is licensed under [MIT](LICENSE).
