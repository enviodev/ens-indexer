// Integration tests for the change stream against a local synced database.
// Needs TEST_PG_PORT (and optionally TEST_PG_PASSWORD) pointing at a database
// with Sepolia (11155111) synced past block 11,950,000. Skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PG_PORT = process.env.TEST_PG_PORT;
const CHAIN = 11155111;
const FROM = 11_820_000;
const TO = 11_950_000;
const skip = !PG_PORT && "TEST_PG_PORT not set";

process.env.ENVIO_PG_PORT = PG_PORT ?? "5433";
process.env.ENVIO_PG_PASSWORD = process.env.TEST_PG_PASSWORD ?? "testing";
const { readChanges, cursorBeforeBlock, cursorOf, decodeCursor, findReorg } = await import("../src/stream.mjs");
const { pool } = await import("../src/db.mjs");

async function readAll(cursor, toBlock, filters) {
  const out = [];
  for (;;) {
    const rows = await readChanges(CHAIN, cursor, toBlock, filters);
    out.push(...rows);
    if (rows.length < 500) return out;
    cursor = cursorOf(rows.at(-1));
  }
}

function startServer(port) {
  const child = spawn(process.execPath, ["src/server.mjs"], { env: { ...process.env, API_PORT: String(port), STREAM_POLL_MS: "200", STREAM_PING_MS: "500" }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve) => child.stdout.on("data", (d) => { if (String(d).includes("listening")) resolve(child); }));
}

// Read SSE changes until one lands after `stopBlock` or `max` arrive. A filtered
// stream may have no later change, so pass `max` (the expected count) for those.
async function sse(url, { stopBlock, max = Infinity, headers = {} }) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal, headers });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const changes = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const msg = buf.slice(0, i); buf = buf.slice(i + 2);
        const fields = Object.fromEntries(msg.split("\n").filter((l) => !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
        if (fields.event !== "change") continue;
        const c = JSON.parse(fields.data);
        if (c.block > stopBlock) return changes;
        changes.push({ ...c, cursor: fields.id });
        if (changes.length >= max) return changes;
      }
    }
  } finally { ctrl.abort(); }
  return changes;
}

test("findReorg flags a changed or vanished block", () => {
  const seen = new Map([[100, "0xa"], [101, "0xb"], [102, "0xc"]]);
  assert.equal(findReorg(seen, new Map([[100, "0xa"], [101, "0xb"], [102, "0xc"]]), 102), undefined);
  assert.equal(findReorg(seen, new Map([[100, "0xa"], [101, "0xX"], [102, "0xc"]]), 102), 101);
  assert.equal(findReorg(seen, new Map([[100, "0xa"]]), 100), 101);
});

test("stream stays open at the committed head and keeps sending pings", { skip, timeout: 60_000 }, async () => {
  const server = await startServer(4394);
  try {
    const [{ progress_block: head }] = (await pool.query(`select progress_block from envio_chains where id = $1`, [CHAIN])).rows;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:4394/v1/stream?chain=${CHAIN}&from=${head - 5}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = "";
    const until = Date.now() + 5000;
    while (Date.now() < until && !/: ping \d+/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    ctrl.abort();
    assert.match(text, /: ping \d+/, "pings at head");
    assert.doesNotMatch(text, /event: error/);
  } finally {
    server.kill();
  }
});

test("stream delivers every change in a block range once, in order", { skip, timeout: 300_000 }, async () => {
  const expected = await readAll(cursorBeforeBlock(FROM), TO, {});
  assert.ok(expected.length > 500, `expected many changes, got ${expected.length}`);
  const server = await startServer(4391);
  try {
    const got = await sse(`http://127.0.0.1:4391/v1/stream?chain=${CHAIN}&from=${FROM}`, { stopBlock: TO });
    assert.deepEqual(got.map((c) => c.id), expected.map((r) => r.id));
    assert.equal(new Set(got.map((c) => c.id)).size, got.length, "no duplicates");

    // Resume from the 300th change: the rest arrives, nothing repeated or skipped.
    const at = got[299];
    const rest = await sse(`http://127.0.0.1:4391/v1/stream?chain=${CHAIN}`, { stopBlock: TO, headers: { "last-event-id": at.cursor } });
    assert.deepEqual(rest.map((c) => c.id), expected.slice(300).map((r) => r.id));
    assert.equal(decodeCursor(at.cursor).id, at.id);

    // Filter by name: pick a node with several changes.
    const counts = new Map();
    for (const r of expected) if (r.node) counts.set(r.node, (counts.get(r.node) ?? 0) + 1);
    const [node] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const name = (await pool.query(`select name from v2_domain where node = $1 and "chainId" = $2 and name is not null limit 1`, [node, CHAIN])).rows[0]?.name;
    if (name) {
      const want = expected.filter((r) => r.node === node).map((r) => r.id);
      const byName = await sse(`http://127.0.0.1:4391/v1/stream?chain=${CHAIN}&from=${FROM}&name=${encodeURIComponent(name)}`, { stopBlock: TO, max: want.length });
      assert.deepEqual(byName.map((c) => c.id), want);
    }

    // Filter by address.
    const address = expected.find((r) => r.address)?.address.toLowerCase();
    const wantAddress = expected.filter((r) => r.address?.toLowerCase() === address).map((r) => r.id);
    const byAddress = await sse(`http://127.0.0.1:4391/v1/stream?chain=${CHAIN}&from=${FROM}&address=${address}`, { stopBlock: TO, max: wantAddress.length });
    assert.deepEqual(byAddress.map((c) => c.id), wantAddress);

    // Filter by kind.
    const wantKind = expected.filter((r) => r.kind === "TRANSFER").map((r) => r.id);
    const byKind = await sse(`http://127.0.0.1:4391/v1/stream?chain=${CHAIN}&from=${FROM}&kinds=TRANSFER`, { stopBlock: TO, max: wantKind.length });
    assert.deepEqual(byKind.map((c) => c.id), wantKind);
  } finally {
    server.kill();
    await pool.end();
  }
});
