#!/usr/bin/env node
// Archive export: writes indexed tables to Parquet, by chain and block range.
//
//   node export/export.mjs --chain 1 --target s3://bucket/ens [--tables a,b] [--full] [--snapshots]
//   node export/export.mjs --chain 1 --target ./archive
//
// The first run (or --full) exports everything up to the committed block. Later
// runs export only what is new since the block recorded in the manifest:
//   - tables with blockNumber: rows in the new block range
//   - tables with updatedBlock: rows changed in the new block range (take the
//     latest row per id when reading several ranges)
//   - other tables (current state only): exported in full runs, or with
//     --snapshots, as a snapshot at the committed block
//
// Layout:  <target>/<table>/chain=<id>/range=<from>-<to>/block_bucket=<n>/*.parquet
//          <target>/<table>/chain=<id>/snapshot=<block>/*.parquet
//          <target>/_manifest/chain=<id>.json
//
// Postgres: ENVIO_PG_HOST, ENVIO_PG_PORT, ENVIO_PG_USER, ENVIO_PG_PASSWORD, ENVIO_PG_DATABASE.
// S3 (R2, MinIO, AWS): S3_ENDPOINT (host[:port]), S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
// S3_REGION (default auto), S3_URL_STYLE (path|vhost, default path), S3_USE_SSL (default true).
// For R2: S3_ENDPOINT=<account-id>.r2.cloudflarestorage.com, S3_REGION=auto.
//
// State tables are read when the job runs, which may be after the committed
// block. The manifest records the committed block before and after the run.
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(" "); return [k, v.join(" ") || true]; }));
const chainId = Number(args.chain);
const target = String(args.target ?? "").replace(/\/$/, "");
if (!chainId || !target) throw new Error("usage: export.mjs --chain <id> --target <s3://bucket/prefix | dir>");
const isS3 = target.startsWith("s3://");
const BUCKET_SIZE = Number(args["bucket-blocks"] ?? 1_000_000);
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

const db = await (await DuckDBInstance.create(":memory:")).connect();
const run = (sql) => db.run(sql);
const rows = async (sql) => (await db.runAndReadAll(sql)).getRowObjectsJson();

await run(`INSTALL postgres; LOAD postgres; INSTALL httpfs; LOAD httpfs;`);
const pgConn = [
  `host=${process.env.ENVIO_PG_HOST ?? "localhost"}`, `port=${process.env.ENVIO_PG_PORT ?? 5433}`,
  `user=${process.env.ENVIO_PG_USER ?? "postgres"}`, `password=${process.env.ENVIO_PG_PASSWORD ?? "testing"}`,
  `dbname=${process.env.ENVIO_PG_DATABASE ?? "envio-dev"}`,
].join(" ");
await run(`ATTACH ${quote(pgConn)} AS pg (TYPE postgres, READ_ONLY)`);
if (isS3) {
  await run(`CREATE SECRET s3 (TYPE s3, KEY_ID ${quote(process.env.S3_ACCESS_KEY_ID ?? "")}, SECRET ${quote(process.env.S3_SECRET_ACCESS_KEY ?? "")},
    ENDPOINT ${quote(process.env.S3_ENDPOINT ?? "s3.amazonaws.com")}, REGION ${quote(process.env.S3_REGION ?? "auto")},
    URL_STYLE ${quote(process.env.S3_URL_STYLE ?? "path")}, USE_SSL ${process.env.S3_USE_SSL === "false" ? "false" : "true"})`);
}

const committed = async () => Number((await rows(`SELECT progress_block FROM pg.public.envio_chains WHERE id = ${chainId}`))[0]?.progress_block ?? -1);
const pinBefore = await committed();
if (pinBefore < 0) throw new Error(`chain ${chainId} has no committed block`);

// Manifest: last exported block per table.
const manifestPath = `${target}/_manifest/chain=${chainId}.json`;
let manifest = { chainId, tables: {}, runs: [] };
if (!args.full) {
  try {
    if (isS3) manifest = JSON.parse((await rows(`SELECT content FROM read_text(${quote(manifestPath)})`))[0].content);
    else if (existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch { /* no manifest yet: full run */ }
}

const tables = (await rows(`SELECT table_name FROM pg.information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  AND table_name NOT LIKE 'envio\\_%' ESCAPE '\\' AND table_name NOT LIKE '%$%' ORDER BY table_name`)).map((r) => r.table_name)
  .filter((t) => !args.tables || String(args.tables).split(",").includes(t));
const columns = async (t) => new Set((await rows(`SELECT column_name FROM pg.information_schema.columns WHERE table_schema = 'public' AND table_name = ${quote(t)}`)).map((r) => r.column_name));

const thisRun = { startedAt: new Date().toISOString(), committedBefore: pinBefore, tables: {} };
for (const table of tables) {
  const cols = await columns(table);
  if (!cols.has("chainId")) continue;
  const blockCol = cols.has("blockNumber") ? "blockNumber" : cols.has("updatedBlock") ? "updatedBlock" : null;
  const last = manifest.tables[table]?.lastBlock ?? -1;
  const t0 = Date.now();
  let path, where;
  if (blockCol) {
    if (last >= pinBefore) continue;
    path = `${target}/${table}/chain=${chainId}/range=${last + 1}-${pinBefore}`;
    where = `"chainId" = ${chainId} AND "${blockCol}" > ${last} AND "${blockCol}" <= ${pinBefore}`;
  } else {
    if (manifest.tables[table] && !args.snapshots) continue;
    path = `${target}/${table}/chain=${chainId}/snapshot=${pinBefore}`;
    where = `"chainId" = ${chainId}`;
  }
  if (!isS3) mkdirSync(path, { recursive: true });
  const select = blockCol
    ? `SELECT *, ("${blockCol}" // ${BUCKET_SIZE}) * ${BUCKET_SIZE} AS block_bucket FROM pg.public."${table}" WHERE ${where}`
    : `SELECT * FROM pg.public."${table}" WHERE ${where}`;
  const [{ n }] = await rows(`SELECT count(*)::BIGINT AS n FROM pg.public."${table}" WHERE ${where}`);
  if (Number(n) > 0) {
    // A partitioned copy writes a directory; a snapshot is one file inside its directory.
    if (blockCol) await run(`COPY (${select}) TO ${quote(path)} (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (block_bucket), OVERWRITE_OR_IGNORE)`);
    else await run(`COPY (${select}) TO ${quote(`${path}/part-0.parquet`)} (FORMAT parquet, COMPRESSION zstd)`);
  }
  const seconds = (Date.now() - t0) / 1000;
  manifest.tables[table] = { kind: blockCol ? `range:${blockCol}` : "snapshot", lastBlock: pinBefore, lastPath: path };
  thisRun.tables[table] = { rows: Number(n), seconds: +seconds.toFixed(2), path };
  console.error(`${table}: ${n} rows in ${seconds.toFixed(1)}s`);
}
thisRun.committedAfter = await committed();
thisRun.finishedAt = new Date().toISOString();
manifest.runs.push(thisRun);

const json = JSON.stringify(manifest, null, 1);
if (isS3) {
  await run(`COPY (SELECT ${quote(json)} AS content) TO ${quote(manifestPath)} (FORMAT csv, HEADER false, QUOTE '', ESCAPE '')`);
} else {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, json);
}
console.log(JSON.stringify({ chainId, target, committedBefore: pinBefore, committedAfter: thisRun.committedAfter, tables: Object.keys(thisRun.tables).length, rows: Object.values(thisRun.tables).reduce((a, t) => a + t.rows, 0), seconds: Object.values(thisRun.tables).reduce((a, t) => a + t.seconds, 0).toFixed(1) }));
