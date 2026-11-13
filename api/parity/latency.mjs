#!/usr/bin/env node
// Measures API latency on one local connection: REST name resolution, a GraphQL
// lookup by name, and a GraphQL owner listing, over names sampled from the database.
//
//   node parity/latency.mjs --api http://127.0.0.1:4350 --chain 1 --pg-port 5433 --count 300 [--out report.json]
import pg from "pg";
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => { const [k, ...v] = a.trim().split(" "); return [k, v.join(" ")]; }));
const api = args.api ?? "http://127.0.0.1:4350";
const chainId = Number(args.chain ?? 1);
const count = Number(args.count ?? 300);

const client = new pg.Client({ host: "localhost", port: Number(args["pg-port"] ?? 5433), user: "postgres", password: args["pg-password"] ?? "testing", database: "envio-dev" });
await client.connect();
// --source v2 (default): registered ENSv2 names; --source v1: named v1 domains with an owner,
// sampled with TABLESAMPLE so the draw does not scan the whole table.
const source = args.source ?? "v2";
const { rows } = source === "v1"
  ? await client.query(`SELECT name, owner_id AS owner FROM subgraph_domain TABLESAMPLE SYSTEM (1) WHERE "chainId" = $1 AND name IS NOT NULL AND name NOT LIKE '%[%' AND owner_id IS NOT NULL AND owner_id <> '0x0000000000000000000000000000000000000000' ORDER BY random() LIMIT $2`, [chainId, count])
  : await client.query(`SELECT name, owner FROM v2_domain WHERE "chainId" = $1 AND name IS NOT NULL AND status = 'REGISTERED' ORDER BY random() LIMIT $2`, [chainId, count]);
if (rows.length === 0) throw new Error(`no ${source} names to sample on chain ${chainId}`);
const [{ n }] = (await client.query(`SELECT count(*)::int AS n FROM ${source === "v1" ? "subgraph_domain" : "v2_domain"} WHERE "chainId" = $1`, [chainId])).rows;
await client.end();

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
async function timed(fn) { const start = performance.now(); await fn(); return performance.now() - start; }
const gql = (query, variables) => fetch(`${api}/graphql?chain=${chainId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) }).then((r) => r.json()).then((j) => { if (j.errors) throw new Error(JSON.stringify(j.errors)); return j; });

const CASES = {
  rest_resolve: (r) => fetch(`${api}/v1/resolve/${encodeURIComponent(r.name)}?chain=${chainId}`).then((x) => { if (!x.ok) throw new Error(String(x.status)); return x.text(); }),
  graphql_domain_by_name: (r) => gql(`query($n:String!){domains(first:1,where:{name:$n}){id name owner{id} resolver{address} expiryDate}}`, { n: r.name }),
  graphql_names_by_owner: (r) => gql(`query($o:String!){domains(first:20,where:{owner:$o},orderBy:expiryDate,orderDirection:desc){id name expiryDate}}`, { o: r.owner }),
};

const out = { chainId, source, rowsInSourceTable: n, sampled: rows.length, method: `sequential requests on localhost, one connection, names sampled at random from ${source === "v1" ? "subgraph_domain" : "v2_domain"}`, results: {} };
for (const [name, fn] of Object.entries(CASES)) {
  const times = [];
  let errors = 0;
  for (const row of rows) {
    try { times.push(await timed(() => fn(row))); } catch { errors++; }
  }
  times.sort((a, b) => a - b);
  // A case where every request failed has no percentiles; keep its error count.
  const p = (q) => (times.length ? +percentile(times, q).toFixed(2) : null);
  out.results[name] = { n: times.length, errors, p50_ms: p(50), p95_ms: p(95), p99_ms: p(99) };
}
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
