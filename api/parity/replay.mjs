#!/usr/bin/env node
// Independent check of the indexed ENSv2 state against raw event data.
//
// Pulls every ENSv2 registry and resolver event for a chain from HyperSync,
// replays it with a reducer written separately from the indexer's handlers, and
// compares the result with every row in v2_domain, v2_registry and the record
// tables. Needs ENVIO_API_TOKEN in the environment.
//
//   node parity/replay.mjs --chain 11155111 --from 11820000 --pg-port 5440 [--out report.json]
import pg from "pg";
import { writeFileSync } from "node:fs";
import { concat, decodeAbiParameters, keccak256, parseAbiParameters, toBytes } from "viem";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(" "); return [k, v.join(" ")]; }));
const chainId = Number(args.chain);
const fromBlock = Number(args.from);
const token = process.env.ENVIO_API_TOKEN;
if (!token) throw new Error("ENVIO_API_TOKEN is not set");

const SEEDS = {
  1: { root: "0x2553c09be6447beffdb86fa622ad41fb8f77a91e", eth: "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2" },
  11155111: { root: "0xb458d6a3a77919449d03e7a6903c26827c1ec43f", eth: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4" },
}[chainId];

const sig = (s) => keccak256(toBytes(s));
const T = {
  LabelRegistered: sig("LabelRegistered(uint256,bytes32,string,address,uint64,address)"),
  LabelReserved: sig("LabelReserved(uint256,bytes32,string,uint64,address)"),
  LabelUnregistered: sig("LabelUnregistered(uint256,address)"),
  ExpiryUpdated: sig("ExpiryUpdated(uint256,uint64,address)"),
  SubregistryUpdated: sig("SubregistryUpdated(uint256,address,address)"),
  ResolverUpdated: sig("ResolverUpdated(uint256,address,address)"),
  TokenRegenerated: sig("TokenRegenerated(uint256,uint256)"),
  TokenResource: sig("TokenResource(uint256,uint256)"),
  TransferSingle: sig("TransferSingle(address,address,address,uint256,uint256)"),
  TransferBatch: sig("TransferBatch(address,address,address,uint256[],uint256[])"),
  Linked: sig("Linked(uint256,bytes32,bytes)"),
  AddressUpdated: sig("AddressUpdated(uint256,uint256,bytes)"),
  TextUpdated: sig("TextUpdated(uint256,string,string,string)"),
  AddrChanged: sig("AddrChanged(bytes32,address)"),
  AddressChanged: sig("AddressChanged(bytes32,uint256,bytes)"),
  TextChanged: sig("TextChanged(bytes32,string,string,string)"),
  RegistryCreated: sig("RegistryCreated()"),
  ParentUpdated: sig("ParentUpdated(address,string,address)"),
};
const NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

async function hypersync(query) {
  const out = [];
  let from = query.from_block;
  for (;;) {
    let j;
    for (let attempt = 0; ; attempt++) {
      // Retry network errors as well as HTTP errors: long runs meet transient timeouts.
      try {
        const res = await fetch(`https://${chainId}.hypersync.xyz/query`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...query, from_block: from }),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) { j = await res.json(); break; }
        if (attempt >= 8) throw new Error(`HyperSync HTTP ${res.status}`);
      } catch (err) {
        if (attempt >= 8) throw err;
      }
      await new Promise((r) => setTimeout(r, 2000 * 2 ** Math.min(attempt, 5)));
    }
    for (const d of j.data ?? []) out.push(...(d.logs ?? []));
    if (query.to_block !== undefined && j.next_block >= query.to_block) break;
    if (j.next_block >= j.archive_height || j.next_block === from) { out.archiveHeight = j.archive_height; break; }
    from = j.next_block;
  }
  return out;
}

const FIELDS = { log: ["block_number", "log_index", "address", "data", "topic0", "topic1", "topic2", "topic3"] };
const MASK = ~0xffffffffn;
const hex32 = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (topic) => `0x${topic.slice(26)}`.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

// Fix the block range first, so HyperSync and the database describe the same blocks.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
const db = new pg.Client({ host: "localhost", port: Number(args["pg-port"] ?? 5440), user: "postgres", password: "testing", database: "envio-dev" });
await db.connect();
await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
const [{ progress_block: toBlockInclusive }] = (await db.query("SELECT progress_block FROM envio_chains WHERE id = $1", [chainId])).rows;
const toBlock = toBlockInclusive + 1;

const registryTopics = ["LabelRegistered", "LabelReserved", "LabelUnregistered", "ExpiryUpdated", "SubregistryUpdated", "ResolverUpdated", "TokenRegenerated", "TokenResource"].map((k) => T[k]);
const regLogs = await hypersync({ from_block: fromBlock, to_block: toBlock, logs: [{ topics: [registryTopics] }], field_selection: FIELDS });
const registries = [...new Set(regLogs.map((l) => l.address.toLowerCase()))];
const transferLogs = [];
for (let i = 0; i < registries.length; i += 500) {
  transferLogs.push(...(await hypersync({ from_block: fromBlock, to_block: toBlock, logs: [{ address: registries.slice(i, i + 500), topics: [[T.TransferSingle, T.TransferBatch]] }], field_selection: FIELDS })));
}
const recordLogs = await hypersync({ from_block: fromBlock, to_block: toBlock, logs: [{ topics: [[T.Linked, T.AddressUpdated, T.TextUpdated]] }], field_selection: FIELDS });

const all = [...regLogs, ...transferLogs].sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);

// ─── Transfers before the registry row ───────────────────────────────────────
// The indexer applies an ERC-1155 transfer only if its address is a seed or
// already has a v2_registry row. A row is created by RegistryCreated, any label,
// link or token event from the address, ParentUpdated, or a SubregistryUpdated
// that points at it. A transfer emitted before that would be skipped; count them.
const pos = (l) => l.block_number * 1_000_000 + l.log_index;
const discovered = new Map(); // address -> position of the event that creates its row
const discover = (a, p) => { if (a && a !== ZERO && (!discovered.has(a) || p < discovered.get(a))) discovered.set(a, p); };
const extraLogs = await hypersync({ from_block: fromBlock, to_block: toBlock, logs: [{ topics: [[T.RegistryCreated, T.ParentUpdated]] }], field_selection: FIELDS });
for (const l of [...regLogs, ...extraLogs]) discover(l.address.toLowerCase(), pos(l));
for (const l of regLogs) if (l.topic0 === T.SubregistryUpdated) discover(addr(l.topic2), pos(l));
for (const a of [SEEDS.root, SEEDS.eth]) discovered.set(a, -1);
const transferCheck = { registries: discovered.size, transfers: 0, beforeRegistryRow: 0, samples: [] };
{
  const addrs = [...discovered.keys()];
  for (let i = 0; i < addrs.length; i += 500) {
    const logs = await hypersync({ from_block: fromBlock, to_block: toBlock, logs: [{ address: addrs.slice(i, i + 500), topics: [[T.TransferSingle, T.TransferBatch]] }], field_selection: FIELDS });
    for (const l of logs) {
      transferCheck.transfers++;
      const a = l.address.toLowerCase();
      if (pos(l) < discovered.get(a)) {
        transferCheck.beforeRegistryRow++;
        if (transferCheck.samples.length < 20) transferCheck.samples.push({ registry: a, block: l.block_number, logIndex: l.log_index, registryRowAt: discovered.get(a) });
      }
    }
  }
}

// ─── Reducer ────────────────────────────────────────────────────────────────
const domains = new Map();
const key = (registry, tokenId) => `${registry}-${hex32(tokenId & MASK)}`;
const dom = (registry, tokenId) => {
  const k = key(registry, tokenId);
  if (!domains.has(k)) domains.set(k, { registry, tokenId, status: "UNREGISTERED", owner: null, expiry: null, resolver: null, subregistry: null, resource: null, label: null, labelhash: null });
  return domains.get(k);
};
for (const l of all) {
  const r = l.address.toLowerCase();
  const name = NAME[l.topic0];
  if (name === "LabelRegistered" || name === "LabelReserved") {
    const d = dom(r, BigInt(l.topic1));
    const [label, a2, a3] = name === "LabelRegistered"
      ? decodeAbiParameters(parseAbiParameters("string, address, uint64"), l.data)
      : decodeAbiParameters(parseAbiParameters("string, uint64"), l.data);
    Object.assign(d, { tokenId: BigInt(l.topic1), labelhash: l.topic2, label, status: name === "LabelRegistered" ? "REGISTERED" : "RESERVED", owner: name === "LabelRegistered" ? a2.toLowerCase() : null, expiry: name === "LabelRegistered" ? a3 : a2, resolver: null, subregistry: null });
    if (name === "LabelRegistered") d.everRegistered = true;
  } else if (name === "LabelUnregistered") {
    Object.assign(dom(r, BigInt(l.topic1)), { status: "UNREGISTERED", owner: null, expiry: "unregistered" });
  } else if (name === "ExpiryUpdated") {
    dom(r, BigInt(l.topic1)).expiry = BigInt(l.topic2);
  } else if (name === "SubregistryUpdated") {
    const s = addr(l.topic2); dom(r, BigInt(l.topic1)).subregistry = s === ZERO ? null : s;
  } else if (name === "ResolverUpdated") {
    const s = addr(l.topic2); dom(r, BigInt(l.topic1)).resolver = s === ZERO ? null : s;
  } else if (name === "TokenResource") {
    dom(r, BigInt(l.topic1)).resource = BigInt(l.topic2);
  } else if (name === "TokenRegenerated") {
    dom(r, BigInt(l.topic1)).tokenId = BigInt(l.topic2);
  } else if (name === "TransferSingle" || name === "TransferBatch") {
    const to = addr(l.topic3);
    const ids = name === "TransferSingle"
      ? [decodeAbiParameters(parseAbiParameters("uint256, uint256"), l.data)[0]]
      : decodeAbiParameters(parseAbiParameters("uint256[], uint256[]"), l.data)[0];
    for (const id of ids) {
      const k = key(r, id);
      if (domains.has(k)) domains.get(k).owner = to === ZERO ? null : to;
    }
  }
}

// Names: walk live links from the two seeds. Links from unregistered labels do not count.
const registryName = new Map([[SEEDS.root, { name: "", node: hex32(0n) }], [SEEDS.eth, { name: "eth", node: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }]]);
const incoming = new Map();
for (const d of domains.values()) {
  if (d.subregistry && d.status !== "UNREGISTERED") {
    if (!incoming.has(d.subregistry)) incoming.set(d.subregistry, []);
    incoming.get(d.subregistry).push(d);
  }
}
const byRegistry = new Map();
for (const d of domains.values()) { if (!byRegistry.has(d.registry)) byRegistry.set(d.registry, []); byRegistry.get(d.registry).push(d); }
const queue = [SEEDS.root, SEEDS.eth];
const multiParent = new Set();
while (queue.length) {
  const r = queue.shift();
  const parent = registryName.get(r);
  for (const d of byRegistry.get(r) ?? []) {
    if (!d.label) continue;
    d.name = parent.name === "" ? d.label : `${d.label}.${parent.name}`;
    d.node = keccak256(concat([parent.node, d.labelhash]));
    if (d.subregistry && d.status !== "UNREGISTERED" && !registryName.has(d.subregistry)) {
      if ((incoming.get(d.subregistry) ?? []).length > 1) multiParent.add(d.subregistry);
      registryName.set(d.subregistry, { name: d.name, node: d.node });
      queue.push(d.subregistry);
    }
  }
}

// ─── Compare with the database ──────────────────────────────────────────────
const rows = (await db.query(
  `SELECT d.*, r.address AS raddr, r.proven FROM v2_domain d JOIN v2_registry r ON r.id = d.registry_id AND r."chainId" = d."chainId" WHERE d."chainId" = $1`, [chainId])).rows;
const FIELDS_CMP = ["status", "owner", "expiry", "tokenId", "resource", "resolver", "subregistry", "label", "name"];
const stats = Object.fromEntries(FIELDS_CMP.map((f) => [f, { checked: 0, matched: 0 }]));
const mismatches = [];
const seen = new Set();
const isAsciiLabel = (s) => s != null && /^[\x21-\x7e]+$/.test(s) && !s.includes(".") && !s.includes("[");
for (const row of rows) {
  const k = `${row.raddr}-${row.storageId}`;
  seen.add(k);
  const e = domains.get(k);
  if (!e) { mismatches.push({ id: row.id, field: "row", indexed: "present", replay: "absent" }); continue; }
  const cmp = (f, a, b) => {
    stats[f].checked++;
    if (String(a ?? null) === String(b ?? null)) stats[f].matched++;
    else mismatches.push({ id: row.id, field: f, indexed: String(a ?? null), replay: String(b ?? null) });
  };
  cmp("status", row.status, e.status);
  cmp("owner", row.owner, e.owner);
  if (e.expiry !== "unregistered") cmp("expiry", row.expiry, e.expiry);
  cmp("tokenId", row.tokenId, e.tokenId);
  cmp("resource", row.resource, e.resource);
  cmp("resolver", row.resolver, e.resolver);
  cmp("subregistry", row.subregistry, e.subregistry);
  cmp("label", row.label, e.label);
  // Names: compare where the label is plain text and the registry has one parent.
  if (isAsciiLabel(e.label) && !multiParent.has(row.raddr)) cmp("name", row.name, e.name);
}
let missing = 0;
for (const k of domains.keys()) if (!seen.has(k)) { missing++; if (missing <= 20) mismatches.push({ id: k, field: "row", indexed: "absent", replay: "present" }); }

// Records: final value per (resolver, record, key).
const recState = new Map();
const linkState = new Map();
for (const l of recordLogs.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index)) {
  const r = l.address.toLowerCase();
  const rec = BigInt(l.topic1);
  if (NAME[l.topic0] === "Linked") linkState.set(`${chainId}-${r}-${l.topic2}`, `${chainId}-${r}-${rec}`);
  else if (NAME[l.topic0] === "AddressUpdated") {
    const [coin, bytes] = decodeAbiParameters(parseAbiParameters("uint256, bytes"), l.data);
    recState.set(`${chainId}-${r}-${rec}-${coin}`, bytes === "0x" ? null : bytes.toLowerCase());
  } else {
    const [k, v] = decodeAbiParameters(parseAbiParameters("string, string"), l.data);
    recState.set(`${chainId}-${r}-${rec}-${k}`, v === "" ? null : v);
  }
}
const dbAddr = new Map((await db.query(`SELECT id, value FROM v2_record_address WHERE "chainId" = $1`, [chainId])).rows.map((x) => [x.id, x.value?.toLowerCase()]));
const dbText = new Map((await db.query(`SELECT id, value FROM v2_record_text WHERE "chainId" = $1`, [chainId])).rows.map((x) => [x.id, x.value]));
const dbLink = new Map((await db.query(`SELECT id, record_id FROM v2_record_link WHERE "chainId" = $1`, [chainId])).rows.map((x) => [x.id, x.record_id]));
const rec = { checked: 0, matched: 0 };
const recMismatch = [];
for (const [k, v] of recState) {
  rec.checked++;
  const got = dbAddr.has(k) ? dbAddr.get(k) : dbText.has(k) ? dbText.get(k) : null;
  if (String(got ?? null) === String(v ?? null)) rec.matched++; else if (recMismatch.length < 20) recMismatch.push({ id: k, indexed: got, replay: v });
}
const links = { checked: 0, matched: 0 };
for (const [k, v] of linkState) { links.checked++; if (dbLink.get(k) === v) links.matched++; else if (recMismatch.length < 40) recMismatch.push({ id: k, indexed: dbLink.get(k), replay: v }); }
// Node-keyed records from any address, compared with v2_node_address / v2_node_text.
const nodeLogs = await hypersync({ from_block: fromBlock, to_block: toBlock, logs: [{ topics: [[T.AddrChanged, T.AddressChanged, T.TextChanged]] }], field_selection: FIELDS });
const nodeState = new Map();
for (const l of nodeLogs.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index)) {
  const base = `${chainId}-${l.address.toLowerCase()}-${l.topic1}`;
  if (NAME[l.topic0] === "AddrChanged") {
    const [a] = decodeAbiParameters(parseAbiParameters("address"), l.data);
    nodeState.set(`${base}-60`, a.toLowerCase() === ZERO ? null : a.toLowerCase());
  } else if (NAME[l.topic0] === "AddressChanged") {
    const [coin, bytes] = decodeAbiParameters(parseAbiParameters("uint256, bytes"), l.data);
    nodeState.set(`${base}-${coin}`, bytes === "0x" ? null : bytes.toLowerCase());
  } else {
    // The indexed key is topic2; a log without it has another ABI and the indexer cannot decode it.
    if (!l.topic2) continue;
    try {
      const [k, v] = decodeAbiParameters(parseAbiParameters("string, string"), l.data);
      if (!k.includes("\u0000")) nodeState.set(`${base}-${k}`, v === "" ? null : v);
    } catch { /* malformed log data: the indexer skips it too */ }
  }
}
const dbNodeAddr = new Map((await db.query(`SELECT id, value FROM v2_node_address WHERE "chainId" = $1`, [chainId])).rows.map((x) => [x.id, x.value]));
const dbNodeText = new Map((await db.query(`SELECT id, value FROM v2_node_text WHERE "chainId" = $1`, [chainId])).rows.map((x) => [x.id, x.value]));
const nodeRecords = { checked: 0, matched: 0 };
for (const [k, v] of nodeState) {
  nodeRecords.checked++;
  const got = dbNodeAddr.has(k) ? dbNodeAddr.get(k) : dbNodeText.has(k) ? dbNodeText.get(k) : null;
  if (String(got ?? null) === String(v ?? null)) nodeRecords.matched++; else if (recMismatch.length < 60) recMismatch.push({ id: k, indexed: got, replay: v });
}
// ─── Legacy projection (ens-subgraph v2.2.0 rules, src/ensv2Domain.ts) ──────
// Expected subgraph_domain / subgraph_registration rows for ENSv2 names, derived from
// the replayed v2 state above, not from the indexer's code:
//  - a REGISTERED name on a named (proven) path outside the root registry: owner and
//    registrant = holder, expiry = expiry (+ 2,419,200 s in the .eth registry), clamped
//    to 253402300799, resolver = "<chain>-<resolver>-<node>", name = path name;
//  - a name registered once and now UNREGISTERED: retired, owner 0x0, no registrant or
//    resolver;
//  - the .eth registry's names also own subgraph_registration (registrant, expiry).
const MAX_LEGACY = 253402300799n, V2_GRACE = 2419200n;
const clampL = (v) => (v > MAX_LEGACY ? MAX_LEGACY : v);
const legacyRows = new Map((await db.query(`SELECT id, name, owner_id, registrant_id, "expiryDate", resolver_id FROM subgraph_domain WHERE "chainId" = $1`, [chainId])).rows.map((r) => [r.id, r]));
const legacyRegs = new Map((await db.query(`SELECT id, registrant_id, "expiryDate" FROM subgraph_registration WHERE "chainId" = $1`, [chainId])).rows.map((r) => [r.id, r]));
const legacy = { live: { checked: 0, matched: 0 }, retired: { checked: 0, matched: 0 }, registrations: { checked: 0, matched: 0 }, missingRows: 0, mismatches: [] };
for (const d of domains.values()) {
  if (!d.node || d.registry === SEEDS.root) continue;
  const isEth = d.registry === SEEDS.eth;
  const row = legacyRows.get(d.node);
  const miss = (kind, field, want, got) => { if (legacy.mismatches.length < 200) legacy.mismatches.push({ node: d.node, name: d.name, kind, field, replay: want, indexed: got }); };
  if (d.status === "REGISTERED" && d.owner) {
    legacy.live.checked++;
    if (!row) { legacy.missingRows++; miss("live", "row", "present", "absent"); continue; }
    const want = {
      owner_id: d.owner, registrant_id: d.owner, name: d.name,
      expiryDate: d.expiry == null ? null : String(clampL(isEth ? BigInt(d.expiry) + V2_GRACE : BigInt(d.expiry))),
      resolver_id: d.resolver ? `${chainId}-${d.resolver}-${d.node}` : null,
    };
    let ok = true;
    for (const [f, v] of Object.entries(want)) if (String(row[f] ?? null) !== String(v ?? null)) { ok = false; miss("live", f, v, row[f] ?? null); }
    if (ok) legacy.live.matched++;
    if (isEth && d.expiry != null) {
      legacy.registrations.checked++;
      const reg = legacyRegs.get(d.node);
      if (reg && reg.registrant_id === d.owner && String(reg.expiryDate) === String(clampL(BigInt(d.expiry)))) legacy.registrations.matched++;
      else miss("registration", "row", { registrant: d.owner, expiry: String(clampL(BigInt(d.expiry))) }, reg ?? null);
    }
  } else if (d.status === "UNREGISTERED" && d.everRegistered) {
    legacy.retired.checked++;
    if (row && row.owner_id === ZERO && row.registrant_id == null && row.resolver_id == null) legacy.retired.matched++;
    else miss("retired", "row", "owner 0x0, no registrant or resolver", row ?? null);
  }
}

await db.query("COMMIT");
await db.end();

const out = {
  chainId, fromBlock, toBlock: toBlockInclusive,
  logs: { registry: regLogs.length, transfers: transferLogs.length, records: recordLogs.length },
  registriesSeen: registries.length, domainsReplayed: domains.size, domainsIndexed: rows.length, missingFromIndex: missing,
  multiParentRegistries: multiParent.size,
  fields: Object.fromEntries(Object.entries(stats).map(([f, s]) => [f, { ...s, rate: s.checked ? +(s.matched / s.checked).toFixed(6) : null }])),
  records: { ...rec, rate: rec.checked ? +(rec.matched / rec.checked).toFixed(6) : null },
  links: { ...links, rate: links.checked ? +(links.matched / links.checked).toFixed(6) : null },
  nodeRecords: { ...nodeRecords, logs: nodeLogs.length, rate: nodeRecords.checked ? +(nodeRecords.matched / nodeRecords.checked).toFixed(6) : null },
  // Expected 0. Non-zero means a registry emitted transfers before the indexer knew it.
  transfersBeforeRegistryRow: transferCheck,
  legacyProjection: { live: legacy.live, retired: legacy.retired, registrations: legacy.registrations, missingRows: legacy.missingRows, mismatchCount: legacy.mismatches.length, mismatches: legacy.mismatches.slice(0, 50) },
  mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 200), recordMismatches: recMismatch,
};
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 1));
const { mismatches: _m, recordMismatches: _r, ...summary } = out;
console.log(JSON.stringify({ ...summary, sampleMismatches: mismatches.slice(0, 6), sampleRecordMismatches: recMismatch.slice(0, 6) }, null, 1));
