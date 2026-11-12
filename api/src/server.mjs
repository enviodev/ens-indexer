// HTTP entry point: GraphQL at /subgraphs/name/ensdomains/ens (and /graphql),
// REST at /v1/resolve/:name, /v1/primary/:address and /v1/status.
import http from "node:http";
import { graphql } from "graphql";
import { applyViews, q } from "./db.mjs";
import { makeContext, schema } from "./subgraph.mjs";
import { resolveName, primaryName } from "./resolve.mjs";
import { serveStream } from "./stream.mjs";

const PORT = Number(process.env.API_PORT ?? 4350);
const DEFAULT_CHAIN = Number(process.env.API_DEFAULT_CHAIN ?? 1);
const MAX_BODY = 1_000_000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.end(JSON.stringify(body));
}

const csv = (v) => (v == null || v === "" ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean));

async function route(req, res) {
  const url = new URL(req.url, "http://local");
  const chainId = Number(url.searchParams.get("chain") ?? DEFAULT_CHAIN);
  if (!Number.isInteger(chainId)) return send(res, 400, { error: "invalid chain" });

  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

  if (req.method === "GET" && url.pathname === "/v1/status") {
    const rows = await q(`SELECT id, start_block, source_block, progress_block, progress_block_time, events_processed, ready_at, end_block FROM envio_chains ORDER BY id`);
    return send(res, 200, { chains: rows.map((r) => ({ chainId: r.id, startBlock: r.start_block, headBlock: r.source_block, progressBlock: r.progress_block, progressBlockTime: r.progress_block_time, eventsProcessed: r.events_processed, ready: r.ready_at != null, blocksBehind: Math.max(0, r.source_block - r.progress_block) })) });
  }

  if (req.method === "GET" && url.pathname === "/v1/stream") return serveStream(req, res, url);

  const resolve = url.pathname.match(/^\/v1\/resolve\/(.+)$/);
  if (req.method === "GET" && resolve) {
    const result = await resolveName(chainId, decodeURIComponent(resolve[1]), { coinTypes: csv(url.searchParams.get("coinTypes")), texts: csv(url.searchParams.get("texts")) });
    return send(res, 200, result);
  }

  const primary = url.pathname.match(/^\/v1\/primary\/(0x[0-9a-fA-F]{40})$/);
  if (req.method === "GET" && primary) {
    return send(res, 200, await primaryName(chainId, primary[1], url.searchParams.get("coinType") ?? undefined));
  }

  if (req.method === "POST" && (url.pathname === "/graphql" || url.pathname.startsWith("/subgraphs/"))) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return send(res, 413, { error: "body too large" });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "invalid json" }); }
    const result = await graphql({ schema, source: body.query, variableValues: body.variables, operationName: body.operationName, contextValue: makeContext(chainId) });
    return send(res, 200, result);
  }

  return send(res, 404, { error: "not found" });
}

// The indexer creates its tables on first start; wait for them.
for (;;) {
  try {
    await applyViews();
    break;
  } catch (err) {
    console.error(`waiting for indexer tables: ${err.message}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

http
  .createServer((req, res) => route(req, res).catch((err) => { console.error(err); send(res, 500, { error: "internal error" }); }))
  .listen(PORT, () => console.log(`ens api listening on :${PORT}`));
