#!/usr/bin/env node
// Compares indexed ENSv2 state with the chain, at the block the indexer has reached.
// Registry state is read with getState/getResolver/getSubregistry through Multicall3.
//
//   node parity/onchain.mjs --chain 11155111 --rpc <url> --pg-port 5433 --sample 200 [--out report.json]
import pg from "pg";
import { decodeFunctionResult, encodeFunctionData, parseAbi, toBytes, toHex } from "viem";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(" "); return [k, v.join(" ")]; }));
const chainId = Number(args.chain ?? 11155111);
const rpc = args.rpc;
const sample = Number(args.sample ?? 200);
if (!rpc) throw new Error("--rpc is required");

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
const client = new pg.Client({ host: "localhost", port: Number(args["pg-port"] ?? 5433), user: "postgres", password: args["pg-password"] ?? "testing", database: "envio-dev" });
await client.connect();

const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const REGISTRY = parseAbi([
  "struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }",
  "function getState(uint256 anyId) view returns (State)",
  "function getResolver(string label) view returns (address)",
  "function getSubregistry(string label) view returns (address)",
]);
const MC = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[])"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
async function rpcCall(method, params) {
  for (let i = 0; ; i++) {
    requests++;
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json = await res.json();
    if (!json.error) { await sleep(300); return json.result; }
    if (i >= 6 || !/rate|limit|timeout/i.test(json.error.message)) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    await sleep(2000 * (i + 1));
  }
}

await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
const [{ progress_block: block }] = (await client.query("SELECT progress_block FROM envio_chains WHERE id = $1", [chainId])).rows;

const STRATA = {
  premigrated_reserved: `d.status = 'RESERVED' AND d."isPremigrated"`,
  registered_seed_registry: `d.status = 'REGISTERED' AND NOT d."isMigrated" AND r.kind <> 'user'`,
  migrated: `d."isMigrated"`,
  user_registry: `r.kind = 'user' AND r.proven AND d.status = 'REGISTERED'`,
};
const OUT = { chainId, block, sampleTarget: sample, strata: {}, mismatches: [] };
const FIELDS = ["status", "owner", "expiry", "tokenId", "resource", "resolver", "subregistry"];

for (const [stratum, where] of Object.entries(STRATA)) {
  const { rows } = await client.query(
    `SELECT d.id, r.address AS registry, d.label, d."tokenId", d.resource, d.status, d.owner, d.expiry, d.resolver, d.subregistry
     FROM v2_domain d JOIN v2_registry r ON r.id = d.registry_id AND r."chainId" = d."chainId"
     WHERE d."chainId" = $1 AND d.label IS NOT NULL AND ${where} ORDER BY random() LIMIT $2`,
    [chainId, sample],
  );
  const stat = { sampled: rows.length, checked: 0, fieldMatches: Object.fromEntries(FIELDS.map((f) => [f, 0])), fieldChecked: Object.fromEntries(FIELDS.map((f) => [f, 0])), callFailures: 0 };
  for (let i = 0; i < rows.length; i += 60) {
    const batch = rows.slice(i, i + 60);
    const calls = batch.flatMap((d) => [
      { target: d.registry, allowFailure: true, callData: encodeFunctionData({ abi: REGISTRY, functionName: "getState", args: [BigInt(d.tokenId)] }) },
      { target: d.registry, allowFailure: true, callData: encodeFunctionData({ abi: REGISTRY, functionName: "getResolver", args: [d.label] }) },
      { target: d.registry, allowFailure: true, callData: encodeFunctionData({ abi: REGISTRY, functionName: "getSubregistry", args: [d.label] }) },
    ]);
    const data = encodeFunctionData({ abi: MC, functionName: "aggregate3", args: [calls] });
    const raw = await rpcCall("eth_call", [{ to: MULTICALL, data }, toHex(block)]);
    const results = decodeFunctionResult({ abi: MC, functionName: "aggregate3", data: raw });
    batch.forEach((d, j) => {
      const [stateR, resolverR, subR] = [results[j * 3], results[j * 3 + 1], results[j * 3 + 2]];
      if (!stateR.success || !resolverR.success || !subR.success) { stat.callFailures++; return; }
      const state = decodeFunctionResult({ abi: REGISTRY, functionName: "getState", data: stateR.returnData });
      const chainResolver = decodeFunctionResult({ abi: REGISTRY, functionName: "getResolver", data: resolverR.returnData }).toLowerCase();
      const chainSub = decodeFunctionResult({ abi: REGISTRY, functionName: "getSubregistry", data: subR.returnData }).toLowerCase();
      stat.checked++;
      const zero = "0x0000000000000000000000000000000000000000";
      // An expired name reads AVAILABLE on-chain while its row keeps the last status,
      // and getResolver/getSubregistry return zero. Only expiry and tokenId are comparable.
      const expiredOnChain = state.status === 0;
      const check = (field, indexed, chain) => {
        stat.fieldChecked[field]++;
        if (String(indexed) === String(chain)) stat.fieldMatches[field]++;
        else OUT.mismatches.push({ stratum, id: d.id, label: d.label, field, indexed: String(indexed), chain: String(chain) });
      };
      const statusName = ["AVAILABLE", "RESERVED", "REGISTERED"][state.status];
      check("expiry", d.expiry ?? 0, state.expiry);
      check("tokenId", d.tokenId, state.tokenId);
      if (!expiredOnChain) {
        check("status", d.status, statusName);
        check("owner", (d.owner ?? zero).toLowerCase(), state.latestOwner.toLowerCase());
        check("resolver", d.resolver ?? zero, chainResolver);
        check("subregistry", d.subregistry ?? zero, chainSub);
      }
      if (d.resource != null) check("resource", d.resource, state.resource);
    });
  }
  OUT.strata[stratum] = stat;
}
await client.query("COMMIT");
await client.end();

OUT.requests = requests;
OUT.totals = Object.fromEntries(FIELDS.map((f) => {
  const m = Object.values(OUT.strata).reduce((a, s) => a + s.fieldMatches[f], 0);
  const c = Object.values(OUT.strata).reduce((a, s) => a + s.fieldChecked[f], 0);
  return [f, { matched: m, checked: c, rate: c ? +(m / c).toFixed(6) : null }];
}));
if (args.out) { const { writeFileSync } = await import("node:fs"); writeFileSync(args.out, JSON.stringify(OUT, null, 1)); }
console.log(JSON.stringify({ chainId, block, requests, totals: OUT.totals, strata: Object.fromEntries(Object.entries(OUT.strata).map(([k, v]) => [k, { sampled: v.sampled, checked: v.checked, callFailures: v.callFailures }])), mismatchCount: OUT.mismatches.length, sampleMismatches: OUT.mismatches.slice(0, 8) }, null, 1));
