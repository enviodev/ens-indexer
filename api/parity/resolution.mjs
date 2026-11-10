#!/usr/bin/env node
// Compares /v1/resolve with the ENS Universal Resolver at the chain's latest block,
// for a random sample of proven v2 names with a resolver.
//
//   node parity/resolution.mjs --chain 11155111 --rpc <url> --api http://127.0.0.1:4350 --pg-port 5433 --sample 100 [--out report.json]
import pg from "pg";
import { decodeFunctionResult, encodeFunctionData, parseAbi, toBytes, toHex, namehash } from "viem";
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(" "); return [k, v.join(" ")]; }));
const chainId = Number(args.chain ?? 11155111);
const rpc = args.rpc;
const api = args.api ?? "http://127.0.0.1:4350";
const sample = Number(args.sample ?? 100);
if (!rpc) throw new Error("--rpc is required");
const UR = args.ur ?? "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";

const URABI = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes, address)"]);
const RES = parseAbi(["function addr(bytes32 node) view returns (address)", "function text(bytes32 node, string key) view returns (string)"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dnsEncode(name) {
  const out = [];
  for (const label of name.split(".")) { const b = toBytes(label); out.push(b.length, ...b); }
  out.push(0);
  return toHex(new Uint8Array(out));
}

async function eth_call(data, block) {
  for (let i = 0; ; i++) {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: UR, data }, block] }) });
    const json = await res.json();
    await sleep(350);
    if (!json.error) return { ok: true, result: json.result };
    if (/rate|too many/i.test(json.error.message) && i < 6) { await sleep(2000 * (i + 1)); continue; }
    return { ok: false, error: json.error };
  }
}

const client = new pg.Client({ host: "localhost", port: Number(args["pg-port"] ?? 5433), user: "postgres", password: args["pg-password"] ?? "testing", database: "envio-dev" });
await client.connect();
const { rows } = await client.query(
  `SELECT d.name, d.resolver FROM v2_domain d JOIN v2_registry r ON r.id = d.registry_id AND r."chainId" = d."chainId"
   WHERE d."chainId" = $1 AND r.proven AND d.status = 'REGISTERED' AND d.resolver IS NOT NULL AND d.name IS NOT NULL AND d.name NOT LIKE '%[%'
     AND d.expiry::numeric > extract(epoch from now())
   ORDER BY random() LIMIT $2`, [chainId, sample]);
await client.end();

const stats = { sampled: rows.length, addr: { match: 0, mismatch: 0, offchainOrError: 0 }, text: { match: 0, mismatch: 0, offchainOrError: 0, keysChecked: 0 } };
const mismatches = [];
for (const { name } of rows) {
  const node = namehash(name);
  const local = await (await fetch(`${api}/v1/resolve/${encodeURIComponent(name)}?chain=${chainId}`)).json();
  const call = await eth_call(encodeFunctionData({ abi: URABI, functionName: "resolve", args: [dnsEncode(name), encodeFunctionData({ abi: RES, functionName: "addr", args: [node] })] }), "latest");
  const localAddr = (local.addresses?.["60"] ?? null)?.toLowerCase() ?? null;
  if (!call.ok) {
    stats.addr.offchainOrError++;
    if (localAddr) mismatches.push({ name, kind: "addr", local: localAddr, chain: `revert: ${JSON.stringify(call.error).slice(0, 120)}` });
  } else {
    const [data] = decodeFunctionResult({ abi: URABI, functionName: "resolve", data: call.result });
    const addr = decodeFunctionResult({ abi: RES, functionName: "addr", data }).toLowerCase();
    const chainAddr = addr === "0x0000000000000000000000000000000000000000" ? null : addr;
    if (chainAddr === localAddr) stats.addr.match++;
    else { stats.addr.mismatch++; mismatches.push({ name, kind: "addr", local: localAddr, chain: chainAddr }); }
  }
  for (const key of Object.keys(local.texts ?? {}).slice(0, 3)) {
    stats.text.keysChecked++;
    const t = await eth_call(encodeFunctionData({ abi: URABI, functionName: "resolve", args: [dnsEncode(name), encodeFunctionData({ abi: RES, functionName: "text", args: [node, key] })] }), "latest");
    if (!t.ok) { stats.text.offchainOrError++; continue; }
    const [data] = decodeFunctionResult({ abi: URABI, functionName: "resolve", data: t.result });
    const value = decodeFunctionResult({ abi: RES, functionName: "text", data });
    if (value === local.texts[key]) stats.text.match++;
    else { stats.text.mismatch++; mismatches.push({ name, kind: "text", key, local: local.texts[key], chain: value }); }
  }
}
const out = { chainId, universalResolver: UR, stats, mismatchCount: mismatches.length, mismatches };
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ chainId, stats, mismatchCount: mismatches.length, sampleMismatches: mismatches.slice(0, 10) }, null, 1));
