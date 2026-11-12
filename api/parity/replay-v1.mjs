#!/usr/bin/env node
// Independent check of the indexed v1 state against raw event data.
//
// Streams v1 events for one chain from HyperSync, replays them with the ENS
// subgraph's rules (written here separately from the indexer's handlers), and
// compares the result with every row in the database:
//   - registry owner and resolver per node (subgraph_domain)
//   - registrar expiry per name (subgraph_registration)
//   - ETH address record per resolver and node (resolver_address_record)
//   - reverse names from StandaloneReverseRegistrar (reverse_name_record)
// Needs ENVIO_API_TOKEN in the environment.
//
//   node parity/replay-v1.mjs --chain 1 --pg-port 5441 [--out report.json]
import pg from "pg";
import { writeFileSync } from "node:fs";
import { concat, decodeAbiParameters, keccak256, parseAbiParameters, toBytes } from "viem";
import { normalize } from "viem/ens";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(" "); return [k, v.join(" ")]; }));
const chainId = Number(args.chain);
const token = process.env.ENVIO_API_TOKEN;
if (!token) throw new Error("ENVIO_API_TOKEN is not set");

const ETH_NODE = "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae";
const BASE_ETH_NODE = "0xff1e3c0eb00ec714e34b6114125fbde1dea2f24a72fbf672e7b7fd5690328e10";
const LINEA_ETH_NODE = "0x527aac89ac1d1de5dd84cff89ec92c69b028ce9ce3fa3d654882474ab4402ec3";
const REVERSE = "0x0000000000d8e504002cc26e3ec46d81971c1664";

const CHAINS = {
  1: { start: 3327417, oldRegistry: "0x314159265dd8dbb310642f98f50c066173c1259b", registry: "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e", registrar: "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85", parentNode: ETH_NODE, reverse: "0x283f227c4bd38ece252c4ae7ece650b0e913f1f9", reverseCoinType: 2147483648n },
  8453: { start: 17522624, registry: "0xb94704422c2a1e396835a571837aa5ae53285a95", registrar: "0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a", parentNode: BASE_ETH_NODE, reverse: REVERSE, reverseCoinType: 2147492101n },
  59144: { start: 6682888, registry: "0x50130b669b28c339991d8676fa73cf122a121267", registrar: "0x6e84390dcc5195414ec91a8c56a5c91021b95704", parentNode: LINEA_ETH_NODE, reverse: REVERSE, reverseCoinType: 2147542792n },
  10: { start: 110393959, reverse: REVERSE, reverseCoinType: 2147483658n },
  42161: { start: 349263357, reverse: REVERSE, reverseCoinType: 2147525809n },
  534352: { start: 16604272, reverse: REVERSE, reverseCoinType: 2148018000n },
};
const C = CHAINS[chainId];
if (!C) throw new Error(`no v1 contracts configured for chain ${chainId}`);

const sig = (s) => keccak256(toBytes(s));
const T = {
  NewOwner: sig("NewOwner(bytes32,bytes32,address)"),
  Transfer: sig("Transfer(bytes32,address)"),
  NewResolver: sig("NewResolver(bytes32,address)"),
  NameRegistered: sig("NameRegistered(uint256,address,uint256)"),
  NameRegisteredWithRecord: sig("NameRegisteredWithRecord(uint256,address,uint256,address,uint64)"),
  NameRenewed: sig("NameRenewed(uint256,uint256)"),
  AddrChanged: sig("AddrChanged(bytes32,address)"),
  AddressChanged: sig("AddressChanged(bytes32,uint256,bytes)"),
  NameForAddrChanged: sig("NameForAddrChanged(address,string)"),
};
const STATIC_RESOLVERS = {
  1: ["0x231b0ee14048e9dccd1d247744d114a4eb5e8e63", "0xa7d635c8de9a58a228aa69353a1699c7cc240dcf", "0xc800dbc8ff9796e58efba2d7b35028ddd1997e5e", "0x0ce08a41bdb10420fb5cac7da8ca508ea313aef8", "0xf9edb1a21867ac11b023ce34abad916d29abf107", "0x4b9572c03aaa8b0efa4b4b0f0cc0f0992bedb898", "0xc4842814ca523e481ca5aa85f719fed1e9cac614"],
  8453: ["0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8"],
  10: ["0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8"],
};
const ZERO = "0x0000000000000000000000000000000000000000";
const addr = (topic) => `0x${topic.slice(26)}`.toLowerCase();
const hex32 = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const FIELDS = { log: ["block_number", "log_index", "address", "data", "topic0", "topic1", "topic2", "topic3"] };

async function stream(query, onLogs) {
  let from = query.from_block;
  let n = 0;
  for (;;) {
    let j;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://${chainId}.hypersync.xyz/query`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ ...query, from_block: from }) });
      if (res.ok) { j = await res.json(); break; }
      if (attempt >= 5) throw new Error(`HyperSync HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    const logs = (j.data ?? []).flatMap((d) => d.logs ?? []);
    n += logs.length;
    onLogs(logs);
    if (j.next_block >= query.to_block || j.next_block === from) break;
    from = j.next_block;
  }
  return n;
}

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
const db = new pg.Client({ host: "localhost", port: Number(args["pg-port"] ?? 5441), user: "postgres", password: "testing", database: "envio-dev" });
await db.connect();
const [{ progress_block: toBlockInclusive }] = (await db.query("SELECT progress_block FROM envio_chains WHERE id = $1", [chainId])).rows;
const toBlock = toBlockInclusive + 1;
const out = { chainId, toBlock: toBlockInclusive, checks: {}, samples: {} };
const record = (name, checked, matched, mismatches) => {
  out.checks[name] = { checked, matched, rate: checked ? +(matched / checked).toFixed(6) : null };
  out.samples[name] = mismatches.slice(0, 25);
};

// ─── Registry: owner and resolver, with the subgraph's old-registry rule ─────
if (C.registry) {
  const owner = new Map();
  const resolver = new Map();
  const migrated = new Set();
  const firstAssigned = new Map(); // resolver -> first block a registry assigned it
  const registries = [C.registry, C.oldRegistry].filter(Boolean);
  const n = await stream({ from_block: C.start, to_block: toBlock, logs: [{ address: registries, topics: [[T.NewOwner, T.Transfer, T.NewResolver]] }], field_selection: FIELDS }, (logs) => {
    for (const l of logs) {
      const isOld = C.oldRegistry && l.address.toLowerCase() === C.oldRegistry;
      if (l.topic0 === T.NewOwner) {
        const node = keccak256(concat([l.topic1, l.topic2]));
        if (isOld && migrated.has(node)) continue;
        owner.set(node, decodeAbiParameters(parseAbiParameters("address"), l.data)[0].toLowerCase());
        if (!isOld && chainId === 1) migrated.add(node);
      } else {
        const node = l.topic1;
        if (isOld && migrated.has(node)) continue;
        const a = decodeAbiParameters(parseAbiParameters("address"), l.data)[0].toLowerCase();
        if (l.topic0 === T.Transfer) owner.set(node, a);
        else {
          resolver.set(node, a === ZERO ? null : a);
          if (a !== ZERO && !firstAssigned.has(a)) firstAssigned.set(a, l.block_number);
        }
      }
    }
  });
  out.registryLogs = n;
  const ownerMismatch = [];
  const resolverMismatch = [];
  let ownerChecked = 0, ownerMatched = 0, resolverChecked = 0, resolverMatched = 0;
  const cursor = await db.query(`SELECT id, owner_id, resolver_id FROM subgraph_domain WHERE "chainId" = $1`, [chainId]);
  for (const row of cursor.rows) {
    if (row.id === hex32(0n)) continue;
    if (owner.has(row.id)) {
      ownerChecked++;
      if (row.owner_id === owner.get(row.id)) ownerMatched++; else ownerMismatch.push({ node: row.id, indexed: row.owner_id, replay: owner.get(row.id) });
    }
    const r = row.resolver_id ? row.resolver_id.split("-")[1] : null;
    const e = resolver.has(row.id) ? resolver.get(row.id) : null;
    resolverChecked++;
    if ((r === ZERO ? null : r) === e) resolverMatched++; else resolverMismatch.push({ node: row.id, indexed: r, replay: e });
  }
  out.nodesReplayed = owner.size;
  out.nodesIndexed = cursor.rows.length;
  record("registryOwner", ownerChecked, ownerMatched, ownerMismatch);
  record("registryResolver", resolverChecked, resolverMatched, resolverMismatch);

  // ─── Resolver ETH address records, applied once a registry assigned the resolver ─
  const addrState = new Map();
  for (const a of STATIC_RESOLVERS[chainId] ?? []) firstAssigned.set(a, 0);
  out.addrLogs = await stream({ from_block: C.start, to_block: toBlock, logs: [{ topics: [[T.AddrChanged, T.AddressChanged]] }], field_selection: FIELDS }, (logs) => {
    for (const l of logs) {
      const r = l.address.toLowerCase();
      const first = firstAssigned.get(r);
      if (first === undefined || first > l.block_number) continue;
      let value;
      if (l.topic0 === T.AddrChanged) value = decodeAbiParameters(parseAbiParameters("address"), l.data)[0].toLowerCase();
      else {
        try {
          const [coin, bytes] = decodeAbiParameters(parseAbiParameters("uint256, bytes"), l.data);
          if (coin !== 60n) continue;
          value = bytes.toLowerCase();
        } catch { continue; }
      }
      addrState.set(`${chainId}-${r}-${l.topic1}-60`, value === ZERO || value === "0x" ? null : value);
    }
  });
  const dbAddr = new Map((await db.query(`SELECT id, value FROM resolver_address_record WHERE "chainId" = $1 AND "coinType" = 60`, [chainId])).rows.map((x) => [x.id, x.value?.toLowerCase() ?? null]));
  const addrMismatch = [];
  let addrMatched = 0;
  for (const [k, v] of addrState) {
    const got = dbAddr.get(k) ?? null;
    if (got === v) addrMatched++; else addrMismatch.push({ id: k, indexed: got, replay: v });
  }
  let extra = 0;
  for (const k of dbAddr.keys()) if (!addrState.has(k)) extra++;
  out.addrRecordsOnlyInIndex = extra;
  record("addr60", addrState.size, addrMatched, addrMismatch);
}

// ─── Registrar expiries ──────────────────────────────────────────────────────
if (C.registrar) {
  const expiry = new Map();
  out.registrarLogs = await stream({ from_block: C.start, to_block: toBlock, logs: [{ address: [C.registrar], topics: [[T.NameRegistered, T.NameRegisteredWithRecord, T.NameRenewed]] }], field_selection: FIELDS }, (logs) => {
    for (const l of logs) {
      const node = keccak256(concat([C.parentNode, l.topic1]));
      const expires = l.topic0 === T.NameRenewed
        ? decodeAbiParameters(parseAbiParameters("uint256"), l.data)[0]
        : decodeAbiParameters(parseAbiParameters("uint256"), l.data.slice(0, 66))[0];
      expiry.set(node, expires);
    }
  });
  const rows = (await db.query(`SELECT domain_id, "expiryDate" FROM subgraph_registration WHERE "chainId" = $1`, [chainId])).rows;
  const mismatch = [];
  let checked = 0, matched = 0;
  for (const row of rows) {
    if (!expiry.has(row.domain_id)) continue;
    checked++;
    if (String(row.expiryDate) === String(expiry.get(row.domain_id))) matched++; else mismatch.push({ node: row.domain_id, indexed: row.expiryDate, replay: String(expiry.get(row.domain_id)) });
  }
  out.registrationsReplayed = expiry.size;
  out.registrationsIndexed = rows.length;
  record("registrarExpiry", checked, matched, mismatch);
}

// ─── Reverse names from the standalone reverse registrar ─────────────────────
{
  const names = new Map();
  out.reverseLogs = await stream({ from_block: C.start, to_block: toBlock, logs: [{ address: [C.reverse], topics: [[T.NameForAddrChanged]] }], field_selection: FIELDS }, (logs) => {
    for (const l of logs) {
      const [name] = decodeAbiParameters(parseAbiParameters("string"), l.data);
      names.set(addr(l.topic1), name);
    }
  });
  const rows = new Map((await db.query(`SELECT address, value FROM reverse_name_record WHERE "chainId" = $1 AND "coinType" = $2`, [chainId, String(C.reverseCoinType)])).rows.map((x) => [x.address, x.value]));
  const mismatch = [];
  let matched = 0;
  for (const [a, name] of names) {
    // Stored names follow the documented rule: ENS-normalised, at most 1 KiB, else none.
    let expected = name;
    try { if (name === "" || normalize(name) !== name || Buffer.byteLength(name) > 1024) expected = null; } catch { expected = null; }
    const got = rows.get(a) ?? null;
    if (got === expected) matched++; else mismatch.push({ address: a, indexed: got, replay: expected });
  }
  record("reverseName", names.size, matched, mismatch);
}

await db.end();
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, samples: Object.fromEntries(Object.entries(out.samples).map(([k, v]) => [k, v.slice(0, 3)])) }, null, 1));
