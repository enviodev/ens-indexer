// Integration test for the Parquet export against a local synced database.
// Needs TEST_PG_PORT with Sepolia (11155111) synced. Skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { DuckDBInstance } from "@duckdb/node-api";

const PG_PORT = process.env.TEST_PG_PORT;
const skip = !PG_PORT && "TEST_PG_PORT not set";
const CHAIN = 11155111;

test("full export matches the database, and a second run adds only a new range", { skip, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ens-export-"));
  const env = { ...process.env, ENVIO_PG_PORT: PG_PORT, ENVIO_PG_PASSWORD: process.env.TEST_PG_PASSWORD ?? "testing" };
  try {
    execFileSync(process.execPath, ["export/export.mjs", "--chain", String(CHAIN), "--target", dir], { env, stdio: ["ignore", "pipe", "ignore"] });
    const manifest = JSON.parse(readFileSync(join(dir, "_manifest", `chain=${CHAIN}.json`), "utf8"));
    const pin = manifest.runs[0].committedBefore;

    const client = new pg.Client({ host: "localhost", port: Number(PG_PORT), user: "postgres", password: env.ENVIO_PG_PASSWORD, database: process.env.ENVIO_PG_DATABASE ?? "envio-dev" });
    await client.connect();
    const duck = await (await DuckDBInstance.create(":memory:")).connect();
    for (const table of ["v2_domain", "v2_transfer", "v2_registration", "subgraph_resolver"]) {
      const blockCol = table === "v2_domain" ? "updatedBlock" : table === "subgraph_resolver" ? null : "blockNumber";
      const where = blockCol ? `and "${blockCol}" <= ${pin}` : "";
      const { rows: [{ n }] } = await client.query(`select count(*)::int n from ${table} where "chainId" = $1 ${where}`, [CHAIN]);
      const parquet = (await duck.runAndReadAll(`select count(*)::int n from read_parquet('${dir}/${table}/chain=${CHAIN}/**/*.parquet')`)).getRowObjectsJson()[0].n;
      assert.equal(Number(parquet), n, `${table}: parquet ${parquet} vs postgres ${n}`);
    }
    await client.end();

    // Second run: a new range directory for block tables, starting after the pin.
    execFileSync(process.execPath, ["export/export.mjs", "--chain", String(CHAIN), "--target", dir], { env, stdio: ["ignore", "pipe", "ignore"] });
    const after = JSON.parse(readFileSync(join(dir, "_manifest", `chain=${CHAIN}.json`), "utf8"));
    assert.equal(after.runs.length, 2);
    const ranges = readdirSync(join(dir, "v2_transfer", `chain=${CHAIN}`));
    assert.ok(ranges.includes(`range=0-${pin}`));
    if (after.runs[1].committedBefore > pin) assert.ok(ranges.includes(`range=${pin + 1}-${after.runs[1].committedBefore}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
