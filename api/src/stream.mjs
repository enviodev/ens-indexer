// Change stream: name-level changes as they are indexed, over Server-Sent Events.
//
//   GET /v1/stream?chain=1&from=<block>&name=a.eth,b.eth&address=0x..&kinds=RECORD,TRANSFER
//
// Each change is sent as `event: change` with an `id:` cursor. Reconnect with
// `?cursor=<id>` or the Last-Event-ID header to resume after that change.
// Only blocks the indexer has committed are sent. If the chain reorganises
// below a block already sent, the server sends `event: reorg` with
// `{"fromBlock": N}`: drop what you received from block N on; the stream then
// resends from N.
import { namehash } from "viem";
import { pool, q } from "./db.mjs";

// Changes come from the existing event tables plus name_event. Each part maps
// a table to (block, log, id, kind, node, address, detail).
const META = `ARRAY['id','blockNumber','transactionID','transactionHash','timestamp','chainId','db_write_timestamp']`;
const logIndexOf = (alias) => `split_part(${alias}.id, '-', 3)::int`;
const v1 = (table, kind, nodeExpr, addressExpr) => ({
  table,
  sql: `SELECT t."chainId" AS chain_id, t."blockNumber" AS block_number, ${logIndexOf("t")} AS log_index, t.id, '${kind}'::text AS kind, 'v1'::text AS protocol,
    ${nodeExpr} AS node, ${addressExpr} AS address, t."transactionID" AS transaction_hash, t.timestamp, to_jsonb(t.*) - ${META} || jsonb_build_object('source', '${table}') AS detail
    FROM ${table} t`,
});
const resolverNode = `split_part(t.resolver_id, '-', 3)`;
const resolverAddr = `split_part(t.resolver_id, '-', 2)`;
const PARTS = [
  v1("subgraph_transfer", "TRANSFER", "t.domain_id", "t.owner_id"),
  v1("subgraph_new_owner", "SUBNAME_OWNER", "t.domain_id", "t.owner_id"),
  v1("subgraph_new_resolver", "RESOLVER", "t.domain_id", resolverAddr),
  v1("subgraph_new_ttl", "TTL", "t.domain_id", "NULL"),
  v1("subgraph_wrapped_transfer", "TRANSFER", "t.domain_id", "t.owner_id"),
  v1("subgraph_name_wrapped", "WRAP", "t.domain_id", "t.owner_id"),
  v1("subgraph_name_unwrapped", "UNWRAP", "t.domain_id", "t.owner_id"),
  v1("subgraph_fuses_set", "FUSES", "t.domain_id", "NULL"),
  v1("subgraph_expiry_extended", "EXPIRY", "t.domain_id", "NULL"),
  v1("subgraph_name_registered", "REGISTRATION", "t.registration_id", "t.registrant_id"),
  v1("subgraph_name_renewed", "EXPIRY", "t.registration_id", "NULL"),
  v1("subgraph_name_transferred", "TRANSFER", "t.registration_id", `t."newOwner_id"`),
  ...["addr_changed", "multicoin_addr_changed", "name_changed", "abi_changed", "pubkey_changed", "text_changed", "contenthash_changed", "interface_changed", "authorisation_changed", "version_changed"]
    .map((e) => v1(`subgraph_${e}`, "RECORD", resolverNode, resolverAddr)),
  {
    table: "v2_registration",
    sql: `SELECT t."chainId", t."blockNumber", ${logIndexOf("t")}, t.id, 'PAYMENT', 'v2', d.node, t.owner, t."transactionHash", t.timestamp,
      to_jsonb(t.*) - ${META} || jsonb_build_object('source', 'v2_registration')
      FROM v2_registration t LEFT JOIN v2_domain d ON d.id = t.domain_id AND d."chainId" = t."chainId"`,
  },
  {
    table: "v2_renewal",
    sql: `SELECT t."chainId", t."blockNumber", ${logIndexOf("t")}, t.id, 'PAYMENT', 'v2', d.node, NULL, t."transactionHash", t.timestamp,
      to_jsonb(t.*) - ${META} || jsonb_build_object('source', 'v2_renewal')
      FROM v2_renewal t LEFT JOIN v2_domain d ON d.id = t.domain_id AND d."chainId" = t."chainId"`,
  },
  {
    table: "v2_transfer",
    sql: `SELECT t."chainId", t."blockNumber", t."logIndex", t.id, 'TRANSFER', 'v2', d.node, t."to", t."transactionHash", t.timestamp,
      to_jsonb(t.*) - ${META} || jsonb_build_object('source', 'v2_transfer')
      FROM v2_transfer t LEFT JOIN v2_domain d ON d.id = t.domain_id AND d."chainId" = t."chainId"`,
  },
  {
    table: "v2_migration",
    sql: `SELECT t."chainId", t."blockNumber", ${logIndexOf("t")}, t.id, 'MIGRATION', 'v2', t.node, t.owner, t."transactionHash", t.timestamp,
      to_jsonb(t.*) - ${META} || jsonb_build_object('source', 'v2_migration')
      FROM v2_migration t`,
  },
  {
    table: "name_event",
    sql: `SELECT t."chainId", t."blockNumber", t."logIndex", t.id, t.kind, t.protocol, t.node, t.address, t."transactionHash", t.timestamp,
      COALESCE(t.detail::jsonb, '{}'::jsonb) || jsonb_build_object('source', 'name_event', 'name', t.name)
      FROM name_event t`,
  },
];

let feedParts;
async function feed() {
  if (feedParts) return feedParts;
  const present = new Set((await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`)).map((r) => r.table_name));
  // v2_migration's id is the node, not a log id: give it the block-ordered id instead.
  feedParts = PARTS.filter((p) => present.has(p.table)).map((p) =>
    p.table === "v2_migration"
      ? { ...p, sql: p.sql.replace(`${logIndexOf("t")}, t.id,`, `0, t."chainId" || '-' || t."blockNumber" || '-m-' || t.id,`) }
      : p,
  );
  return feedParts;
}

export const MAX_BATCH = 500;
// Largest Postgres int: a cursor past every log in a block.
const MAX_LOG_INDEX = 2147483647;

/**
 * Changes strictly after `cursor` (block, log, id, source) up to `toBlock`, in order.
 * One log can write rows with the same id to two tables (a legacy reverse
 * NameChanged writes subgraph_name_changed and name_event), so the source table
 * is part of the order. Filters: nodes, addresses, kinds (arrays or undefined).
 */
export async function readChanges(chainId, cursor, toBlock, { nodes, addresses, kinds } = {}, limit = MAX_BATCH) {
  const parts = await feed();
  const values = [chainId, cursor.block, cursor.log, cursor.id, toBlock, cursor.source ?? ""];
  const where = [`chain_id = $1`, `block_number >= $2`, `block_number <= $5`,
    `(block_number > $2 OR (block_number = $2 AND (log_index > $3 OR (log_index = $3 AND (id COLLATE "C" > $4 OR (id = $4 AND (detail->>'source') COLLATE "C" > $6))))))`];
  if (nodes?.length) { values.push(nodes); where.push(`node = ANY($${values.length})`); }
  if (addresses?.length) { values.push(addresses); where.push(`lower(address) = ANY($${values.length})`); }
  if (kinds?.length) { values.push(kinds); where.push(`kind = ANY($${values.length})`); }
  const inner = parts.map((p) => `SELECT * FROM (${p.sql}) s(chain_id, block_number, log_index, id, kind, protocol, node, address, transaction_hash, timestamp, detail)
    WHERE chain_id = $1 AND block_number >= $2 AND block_number <= $5`).join("\nUNION ALL\n");
  const sql = `SELECT * FROM (${inner}) f WHERE ${where.join(" AND ")} ORDER BY block_number, log_index, id COLLATE "C", (detail->>'source') COLLATE "C" LIMIT ${limit}`;
  return (await pool.query(sql, values)).rows;
}

export const cursorOf = (r) => ({ block: r.block_number, log: r.log_index, id: r.id, source: r.detail?.source ?? "" });
export const encodeCursor = (c) => Buffer.from(`${c.block}:${c.log}:${c.id}:${c.source ?? ""}`).toString("base64url");
export function decodeCursor(s) {
  // Cursors from before the source was added have three parts. Ids contain no ":".
  const [block, log, id, source = ""] = Buffer.from(s, "base64url").toString().split(":");
  return { block: Number(block), log: Number(log), id, source };
}
// Start from the beginning of a block: before every change in it.
export const cursorBeforeBlock = (block) => ({ block, log: -1, id: "", source: "" });

/**
 * Reorg check. `seen` maps block number -> block hash as recorded when changes
 * from that block were sent. Returns the lowest block whose hash changed or
 * disappeared below `progress`, or undefined.
 */
export function findReorg(seen, checkpoints, progress) {
  let lowest;
  for (const [block, hash] of seen) {
    const now = checkpoints.get(block);
    const gone = block > progress;
    if (gone || (now !== undefined && hash !== undefined && now !== hash)) {
      if (lowest === undefined || block < lowest) lowest = block;
    }
  }
  return lowest;
}

async function chainState(chainId, sinceBlock) {
  const [c] = await q(`SELECT progress_block FROM envio_chains WHERE id = $1`, [chainId]);
  const rows = await q(`SELECT block_number, block_hash FROM envio_checkpoints WHERE chain_id = $1 AND block_number >= $2`, [chainId, sinceBlock]);
  return { progress: c?.progress_block ?? -1, checkpoints: new Map(rows.map((r) => [r.block_number, r.block_hash])) };
}

const shape = (r) => ({
  chainId: r.chain_id, block: r.block_number, logIndex: r.log_index, id: r.id, kind: r.kind, protocol: r.protocol,
  node: r.node, address: r.address, transactionHash: r.transaction_hash, timestamp: r.timestamp, detail: r.detail,
});

/** Serve one SSE connection until the client goes away. */
export async function serveStream(req, res, url) {
  const chainId = Number(url.searchParams.get("chain") ?? process.env.API_DEFAULT_CHAIN ?? 1);
  const list = (k) => url.searchParams.get(k)?.split(",").map((s) => s.trim()).filter(Boolean);
  const nodes = list("name")?.map((n) => namehash(n.toLowerCase()));
  const addresses = list("address")?.map((a) => a.toLowerCase());
  const kinds = list("kinds")?.map((k) => k.toUpperCase());
  const resume = req.headers["last-event-id"] ?? url.searchParams.get("cursor");
  let cursor;
  if (resume) cursor = decodeCursor(resume);
  else if (url.searchParams.has("from")) cursor = cursorBeforeBlock(Number(url.searchParams.get("from")));
  else cursor = cursorBeforeBlock(((await chainState(chainId, 0)).progress ?? 0) + 1);

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
  let open = true;
  req.on("close", () => { open = false; });
  const seen = new Map(); // block -> hash at send time, for the reorg window
  const REORG_WINDOW = Number(process.env.STREAM_REORG_WINDOW ?? 256);
  const pollMs = Number(process.env.STREAM_POLL_MS ?? 1000);
  let lastPing = Date.now();
  const pingMs = Number(process.env.STREAM_PING_MS ?? 15000);
  let failures = 0;

  while (open) {
    try {
    const state = await chainState(chainId, Math.max(0, cursor.block - REORG_WINDOW));
    const reorgAt = findReorg(seen, state.checkpoints, state.progress);
    if (reorgAt !== undefined) {
      res.write(`event: reorg\ndata: ${JSON.stringify({ chainId, fromBlock: reorgAt })}\n\n`);
      for (const b of [...seen.keys()]) if (b >= reorgAt) seen.delete(b);
      cursor = cursorBeforeBlock(reorgAt);
      continue;
    }
    const rows = cursor.block <= state.progress ? await readChanges(chainId, cursor, state.progress, { nodes, addresses, kinds }) : [];
    for (const r of rows) {
      cursor = cursorOf(r);
      if (!seen.has(r.block_number)) seen.set(r.block_number, state.checkpoints.get(r.block_number));
      res.write(`id: ${encodeCursor(cursor)}\nevent: change\ndata: ${JSON.stringify(shape(r), (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
    }
    for (const b of [...seen.keys()]) if (b < state.progress - REORG_WINDOW) seen.delete(b);
    if (rows.length === MAX_BATCH) continue;
    // Nothing more below the committed head: move the cursor up to it, so a
    // resume does not rescan empty blocks.
    if (state.progress >= cursor.block && rows.length === 0 && cursor.block < state.progress) {
      cursor = { block: state.progress, log: MAX_LOG_INDEX, id: "~", source: "" };
    }
    if (Date.now() - lastPing > pingMs) { res.write(`: ping ${state.progress}\n\n`); lastPing = Date.now(); }
    failures = 0;
    await new Promise((r) => setTimeout(r, pollMs));
    } catch (err) {
      // A failed read must not end the stream: report it and retry from the same cursor.
      failures++;
      console.error(`stream read failed (${failures}):`, err.message);
      if (open) res.write(`event: error\ndata: ${JSON.stringify({ message: "read failed, retrying", attempt: failures })}\n\n`);
      await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** failures)));
    }
  }
  res.end();
}
