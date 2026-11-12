# Running locally

Requirements: Node.js 22 or later, pnpm, Docker (`envio dev` runs Postgres in it), and an Envio API token for HyperSync (`ENVIO_API_TOKEN` in `.env`; get one at https://envio.dev/app/api-tokens).

## Indexer

```bash
pnpm install
pnpm codegen
TUI_OFF=true pnpm dev        # Postgres and Hasura in Docker, indexing all chains
```

To use your own Postgres instead, run `pnpm envio start` with `ENVIO_PG_HOST`, `ENVIO_PG_PORT`, `ENVIO_PG_USER`, `ENVIO_PG_PASSWORD` and `ENVIO_PG_DATABASE`. Set `ENVIO_HASURA=false` if you do not need Hasura.

A full sync of every chain makes a large database, over 100 GB by our estimate. Check free disk space first. Indexing is limited by Postgres reads more than by fetching; `ENVIO_IN_MEMORY_OBJECTS_TARGET` (entities kept in memory, default 100,000) helps on a machine with memory to spare.

## Tests

```bash
pnpm test                    # indexer tests; they read real blocks through HyperSync
cd api && pnpm install
TEST_PG_PORT=5433 pnpm test  # API tests against a synced local database (skipped without TEST_PG_PORT)
```

## API

```bash
cd api
ENVIO_PG_PORT=5433 API_PORT=4350 node src/server.mjs
```

## Checking the data

- `api/parity/replay.mjs` (ENSv2) and `api/parity/replay-v1.mjs` (v1) rebuild state from raw HyperSync events and compare it with every row.
- `api/parity/latency.mjs` measures API latency.
