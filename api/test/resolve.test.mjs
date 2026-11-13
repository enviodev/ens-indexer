// Name resolution. The namehash test needs no database. The others need TEST_PG_PORT
// pointing at a database with Ethereum and Base synced to head; skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";

const PG_PORT = process.env.TEST_PG_PORT;
const skip = !PG_PORT && "TEST_PG_PORT not set";
process.env.ENVIO_PG_PORT = PG_PORT ?? "5433";
process.env.ENVIO_PG_PASSWORD = process.env.TEST_PG_PASSWORD ?? "testing";
const { namehash, resolveName } = await import("../src/resolve.mjs");
const { pool, q } = await import("../src/db.mjs");

test("labels that look like hex are hashed as text", () => {
  // keccak256(toBytes("0xbabaa")) would hash the bytes 0x0babaa.
  assert.equal(namehash("0xbabaa.base.eth"), "0xcc0ae5e11d2391058a291b790fbe79fc3c3b4546128fbb65a38f339067abac55");
  assert.equal(namehash("0x09906.eth"), "0xcb6f07c7f491b569dfedd7e1f397d1d4b65592a90750f5c417b2fa68207d8f44");
});

test("a Basename with a hex-looking label resolves on Base", { skip }, async () => {
  const r = await resolveName(8453, "0xbabaa.base.eth");
  assert.equal(r.node, "0xcc0ae5e11d2391058a291b790fbe79fc3c3b4546128fbb65a38f339067abac55");
  assert.equal(r.registered, true);
});

test("a v2 name on a node-keyed resolver gets every record, not only those set since the ENSv2 start", { skip }, async () => {
  // A registered v2 .eth name (node 0x2beee5…) points at node-keyed resolver 0xe5a02770.
  // Its ETH address and five text keys were set before the ENSv2 start block, so they
  // are only in the v1 record tables; v2_node_text holds the five set since.
  const r = await resolveName(1, "dominioscripto.eth");
  assert.equal(r.authority, "v2");
  assert.equal(r.recordSource, "node-record");
  assert.equal(r.addresses["60"], "0x02fa71cbb4b1b990a475deb370d0aa42aa43503b");
  assert.ok(Object.keys(r.texts).length >= 10, `texts: ${Object.keys(r.texts).length}`);
});

test("the unified view answers a lookup by name without JIT or a scan of v2_domain", { skip }, async () => {
  // With JIT on, the view's high estimated cost made every query compile for about 1 s.
  const [{ jit }] = await q("SHOW jit");
  assert.equal(jit, "off");
  const plan = (await q(`EXPLAIN (ANALYZE, FORMAT TEXT) SELECT * FROM ens_unified_domain WHERE "chainId" = 1 AND name = $1 ORDER BY id LIMIT 1`, ["nick.eth"]))
    .map((r) => r["QUERY PLAN"]).join("\n");
  assert.doesNotMatch(plan, /JIT:/);
  assert.doesNotMatch(plan, /Seq Scan on "v2_domain/);
});

test.after(() => pool.end());
