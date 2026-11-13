# Archive export

`api/export/export.mjs` writes tables to Parquet with DuckDB, for one chain at a time.

```bash
cd api
# local directory
ENVIO_PG_PORT=5433 node export/export.mjs --chain 1 --target ./archive
# S3-compatible storage (R2, MinIO, AWS S3)
S3_ENDPOINT=<host> S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_REGION=auto \
  node export/export.mjs --chain 1 --target s3://bucket/ens
```

For Cloudflare R2, set `S3_ENDPOINT=<account-id>.r2.cloudflarestorage.com` and `S3_REGION=auto`. For a local MinIO over plain HTTP, add `S3_USE_SSL=false`.

## What is written

- **Tables with a block column** (`blockNumber` or `updatedBlock`) are written by block range:
  `<table>/chain=<id>/range=<from>-<to>/block_bucket=<n>/*.parquet`. Buckets hold a million blocks each (`--bucket-blocks` to change).
- **Tables that hold only current state** are written as snapshots: `<table>/chain=<id>/snapshot=<block>/part-0.parquet`.
- **The manifest** at `_manifest/chain=<id>.json` records the last block exported per table, and each run's committed block before and after.

The first run exports everything up to the committed block. Later runs export only new block ranges. `--full` starts again in an empty target (it stops if the target already has a manifest, since the new ranges would overlap the old ones), and `--snapshots` writes new snapshots of state tables in an incremental run.

For a table with `updatedBlock`, a range holds the rows that changed in it. Take the latest row per `id` when reading several ranges.

Snapshots are read while the indexer runs, so they can include changes after the committed block in the manifest.

## Values and resources

Numeric columns are written as text (`numeric[]` as text arrays), so wei amounts, token ids and expiries keep every digit. Cast them when reading if your tool needs a number type that can hold them.

Each block bucket is written by its own query, so memory stays bounded on any table size. Defaults: DuckDB `memory_limit` 6 GB (`EXPORT_MEMORY_LIMIT`), 4 threads (`EXPORT_THREADS`). Set `EXPORT_TEMP_DIR` to let DuckDB spill to disk, capped by `EXPORT_MAX_TEMP` (default 15 GB). A full Ethereum mainnet export (70 tables, about 90M rows, 7 GB of Parquet) takes about 4.5 minutes and under 1 GB of memory.
