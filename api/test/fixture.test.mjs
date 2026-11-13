// API tests on hand-written rows. They build a small schema in a scratch database
// (ens_api_fixture, dropped and recreated), so they need only an empty Postgres:
//   TEST_FIXTURE_PG_PORT=5499 pnpm test
// Skipped without TEST_FIXTURE_PG_PORT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { namehash as viemNamehash, labelhash } from "viem";

const PORT = process.env.TEST_FIXTURE_PG_PORT;
const skip = !PORT && "TEST_FIXTURE_PG_PORT not set";
const DB = "ens_api_fixture";
const PASSWORD = process.env.TEST_FIXTURE_PG_PASSWORD ?? "testing";
const conn = (database) => ({ host: "localhost", port: Number(PORT ?? 5499), user: "postgres", password: PASSWORD, database });

// Only the columns the API reads.
const SCHEMA = `
CREATE TABLE envio_chains (id int PRIMARY KEY, progress_block int, progress_block_time timestamptz);
CREATE TABLE envio_checkpoints (chain_id int, block_number int, block_hash text);
CREATE TABLE v2_domain (id text, "chainId" int, registry_id text, node text, status text, expiry numeric, resolver text, subregistry text, owner text, "isPremigrated" bool, "isMigrated" bool);
CREATE TABLE v2_registry (id text, "chainId" int, node text, proven bool);
CREATE TABLE v2_migration (id text, "chainId" int, node text, owner text, controller text, "blockNumber" int, timestamp numeric, "transactionHash" text);
CREATE TABLE legacy_projection (id text, "chainId" int, active bool);
CREATE TABLE subgraph_domain (id text, "chainId" int, name text, "labelName" text, labelhash text, parent_id text, "subdomainCount" int,
  "resolvedAddress_id" text, resolver_id text, ttl numeric, "isMigrated" bool, "createdAt" numeric, owner_id text, registrant_id text,
  "wrappedOwner_id" text, "expiryDate" numeric);
CREATE TABLE subgraph_registration (id text, "chainId" int, "registrationDate" numeric, "expiryDate" numeric, cost numeric, "labelName" text, domain_id text, registrant_id text);
CREATE TABLE domain_resolver_relation (id text, "chainId" int, address text, "domainId" text, resolver text);
CREATE TABLE migrated_node_by_node (id text, "chainId" int);
CREATE TABLE reverse_name_record (id text, "chainId" int, address text, "coinType" numeric, value text);
CREATE TABLE resolver_address_record (id text, "chainId" int, address text, node text, "coinType" numeric, value text);
CREATE TABLE resolver_text_record (id text, "chainId" int, address text, node text, key text, value text);
CREATE TABLE subgraph_resolver (id text, "chainId" int, "contentHash" text);
CREATE TABLE name_event (id text, "chainId" int, "blockNumber" int, "logIndex" int, timestamp numeric, "transactionHash" text,
  kind text, protocol text, node text, name text, address text, detail text);
CREATE TABLE subgraph_name_changed (id text, "chainId" int, "blockNumber" int, "transactionID" text, timestamp numeric,
  db_write_timestamp timestamptz, resolver_id text, name text);
`;

if (PORT) {
  const admin = new pg.Client(conn("postgres"));
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  const c = new pg.Client(conn(DB));
  await c.connect();
  await c.query(SCHEMA);
  await c.end();
}
process.env.ENVIO_PG_PORT = PORT ?? "5499";
process.env.ENVIO_PG_DATABASE = DB;
process.env.ENVIO_PG_PASSWORD = PASSWORD;
process.env.STREAM_POLL_MS = "20";
const { resolveName, primaryName } = await import("../src/resolve.mjs");
const { pool, q, applyViews } = await import("../src/db.mjs");
const stream = await import("../src/stream.mjs");
if (PORT) await applyViews();

const OLD_REGISTRY = "0x314159265dD8dbb310642f98f50C066173C1259b";
const NEW_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

test("a migrated name's resolver comes from the new registry only", { skip }, async () => {
  const OLD = "0x00000000000000000000000000000000000000d1";
  const NEW = "0x00000000000000000000000000000000000000d2";
  const rel = (registry, name, resolver) =>
    q(`INSERT INTO domain_resolver_relation VALUES ($1, 1, $2, $3, $4)`, [`1-${registry}-${name}`, registry, viemNamehash(name), resolver]);
  // Migrated, resolver set on both registries: the old row is stale.
  await rel(OLD_REGISTRY, "moved.eth", OLD);
  await rel(NEW_REGISTRY, "moved.eth", NEW);
  await q(`INSERT INTO migrated_node_by_node VALUES ($1, 1)`, [viemNamehash("moved.eth")]);
  assert.equal((await resolveName(1, "moved.eth")).resolver, NEW);
  // Migrated, resolver cleared on the new registry (its row deleted): no resolver.
  await rel(OLD_REGISTRY, "cleared.eth", OLD);
  await q(`INSERT INTO migrated_node_by_node VALUES ($1, 1)`, [viemNamehash("cleared.eth")]);
  assert.equal((await resolveName(1, "cleared.eth")).resolver, null);
  // Not migrated: the old registry answers.
  await rel(OLD_REGISTRY, "kept.eth", OLD);
  assert.equal((await resolveName(1, "kept.eth")).resolver, OLD);
});

test("a primary name is verified against the coin type of its reverse record", { skip }, async () => {
  const chain = 8453;
  const coinType = 2147492101; // Base
  const address = "0x00000000000000000000000000000000000a11ce";
  const resolver = "0x00000000000000000000000000000000000000e5";
  const node = viemNamehash("alice.base.eth");
  await q(`INSERT INTO reverse_name_record VALUES ($1, $2, $3, $4, $5)`, [`${chain}-${address}-${coinType}`, chain, address, coinType, "alice.base.eth"]);
  await q(`INSERT INTO domain_resolver_relation VALUES ($1, $2, $3, $4, $5)`, [`${chain}-r-${node}`, chain, "0x00000000000000000000000000000000000000b5", node, resolver]);
  await q(`INSERT INTO resolver_address_record VALUES ($1, $2, $3, $4, $5, $6)`, [`${chain}-a-${node}`, chain, resolver, node, coinType, address]);
  const r = await primaryName(chain, address);
  assert.equal(r.name, "alice.base.eth");
  assert.equal(r.coinType, String(coinType));
  assert.equal(r.verified, true);
});

// A request and response that serveStream can drive without a socket.
function fakeConnection(chain, query) {
  const req = Object.assign(new EventEmitter(), { headers: {}, destroyed: false });
  const res = Object.assign(new EventEmitter(), {
    writes: [], destroyed: false, writable: true, ended: false, accept: true,
    writeHead() {},
    write(chunk) { this.writes.push(String(chunk)); return this.accept; },
    end() { this.ended = true; },
  });
  const url = new URL(`http://local/v1/stream?chain=${chain}${query}`);
  return { req, res, url, close: () => { req.destroyed = true; res.destroyed = true; req.emit("close"); res.emit("close"); } };
}
const changes = (res) => res.writes.filter((w) => w.includes("event: change")).map((w) => JSON.parse(w.slice(w.indexOf("data: ") + 6)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(() => pool.end());
