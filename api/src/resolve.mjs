// Name resolution from indexed state. Mirrors LibResolution.findResolver: walk
// from the root registry, remember the deepest resolver, stop where a registry
// has no subregistry. Expired entries read as empty, as in the contracts.
import { labelhash as viemLabelhash, namehash as viemNamehash } from "viem";
import { q } from "./db.mjs";
import { DEPLOYMENTS, decideAuthority } from "./authority.mjs";

export { DEPLOYMENTS, decideAuthority };

const ROOT = `0x${"00".repeat(32)}`;
const EMPTY_RECORDS = { addresses: {}, texts: {}, contenthash: null, recordSource: "none" };
// viem hashes a label as UTF-8 text (and reads "[hash]" as an encoded labelhash).
// keccak256(toBytes(label)) would hash a label such as "0xbabaa" as hex bytes.
const labelhash = (l) => viemLabelhash(l);
const storageId = (hash) => `0x${(BigInt(hash) & ~0xffffffffn).toString(16).padStart(64, "0")}`;

export function namehash(name) {
  return viemNamehash(name);
}

export async function walkV2(chainId, name, now = BigInt(Math.floor(Date.now() / 1000))) {
  const deployment = DEPLOYMENTS[chainId];
  if (!deployment) return { found: false, reason: "no ENSv2 deployment on this chain" };
  const labels = name === "" ? [] : name.split(".").reverse();
  let registry = deployment.root;
  let resolver;
  let resolverDepth = -1;
  let leaf;
  for (let depth = 0; depth < labels.length; depth++) {
    if (!registry) break;
    const id = `${chainId}-${registry}-${storageId(labelhash(labels[depth]))}`;
    const [row] = await q(`SELECT * FROM v2_domain WHERE id = $1 AND "chainId" = $2`, [id, chainId]);
    const live = row && row.status !== "UNREGISTERED" && row.expiry != null && BigInt(row.expiry) > now;
    if (!live) { registry = undefined; leaf = undefined; break; }
    if (row.resolver) { resolver = row.resolver; resolverDepth = depth; }
    registry = row.subregistry ?? undefined;
    leaf = depth === labels.length - 1 ? row : undefined;
  }
  return { found: true, resolver, exact: resolverDepth === labels.length - 1, leaf, deployment };
}

async function recordsFromV2Resolver(chainId, resolver, node, coinTypes, textKeys) {
  const resolverId = `${chainId}-${resolver}`;
  const [link] = await q(`SELECT record_id FROM v2_record_link WHERE id = $1 AND "chainId" = $2 AND active`, [`${resolverId}-${node}`, chainId]);
  let recordId = link?.record_id;
  if (!recordId) {
    const [fallback] = await q(`SELECT record_id FROM v2_record_link WHERE id = $1 AND "chainId" = $2 AND active`, [`${resolverId}-${ROOT}`, chainId]);
    recordId = fallback?.record_id;
  }
  if (!recordId) return undefined;
  const [record] = await q(`SELECT contenthash, "primaryName" FROM v2_record WHERE id = $1 AND "chainId" = $2`, [recordId, chainId]);
  const addresses = await q(`SELECT "coinType", value FROM v2_record_address WHERE record_id = $1 AND "chainId" = $2`, [recordId, chainId]);
  const texts = await q(`SELECT key, value FROM v2_record_text WHERE record_id = $1 AND "chainId" = $2`, [recordId, chainId]);
  return shape(addresses, texts, record?.contenthash, coinTypes, textKeys, "v2-record", recordId);
}

// Node-keyed records seen on any address since the ENSv2 start block. Used for
// resolvers a proven v2 domain points at, which may not be watched as v1 resolvers.
async function recordsFromV2NodeResolver(chainId, resolver, node, coinTypes, textKeys) {
  const addresses = await q(`SELECT "coinType", value FROM v2_node_address WHERE resolver = $1 AND node = $2 AND "chainId" = $3`, [resolver, node, chainId]);
  const texts = await q(`SELECT key, value FROM v2_node_text WHERE resolver = $1 AND node = $2 AND "chainId" = $3`, [resolver, node, chainId]);
  const [row] = await q(`SELECT contenthash FROM v2_node_record WHERE id = $1 AND "chainId" = $2`, [`${chainId}-${resolver}-${node}`, chainId]);
  if (addresses.length === 0 && texts.length === 0 && !row?.contenthash) return undefined;
  return shape(addresses, texts, row?.contenthash, coinTypes, textKeys, "v2-node-record");
}

async function recordsFromNodeResolver(chainId, resolver, node, coinTypes, textKeys) {
  const addresses = await q(`SELECT "coinType", value FROM resolver_address_record WHERE address = $1 AND node = $2 AND "chainId" = $3`, [resolver, node, chainId]);
  const texts = await q(`SELECT key, value FROM resolver_text_record WHERE address = $1 AND node = $2 AND "chainId" = $3`, [resolver, node, chainId]);
  const [row] = await q(`SELECT "contentHash" FROM subgraph_resolver WHERE id = $1 AND "chainId" = $2`, [`${chainId}-${resolver}-${node}`, chainId]);
  if (addresses.length === 0 && texts.length === 0 && !row?.contentHash) return undefined;
  return shape(addresses, texts, row?.contentHash, coinTypes, textKeys, "node-record");
}

function shape(addresses, texts, contenthash, coinTypes, textKeys, source, recordId) {
  const addrOut = {};
  for (const a of addresses) if (!coinTypes || coinTypes.includes(String(a.coinType))) addrOut[String(a.coinType)] = a.value;
  const textOut = {};
  for (const t of texts) if (!textKeys || textKeys.includes(t.key)) textOut[t.key] = t.value;
  return { addresses: addrOut, texts: textOut, contenthash: contenthash ?? null, recordSource: source, recordId };
}

// Mainnet keeps one domain_resolver_relation row per registry. Once a node is
// migrated to the new registry, its old-registry row is stale: the indexer stops
// applying old-registry events to it (src/handlers/Registry.ts).
const REGISTRY_MIGRATION = {
  1: { old: "0x314159265dd8dbb310642f98f50c066173c1259b", new: "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e" },
};

async function v1Resolver(chainId, name) {
  const migration = REGISTRY_MIGRATION[chainId];
  let cursor = name;
  for (;;) {
    const node = namehash(cursor);
    let registry = null;
    if (migration) {
      const [migrated] = await q(`SELECT 1 FROM migrated_node_by_node WHERE id = $1 AND "chainId" = $2`, [node, chainId]);
      registry = migrated ? migration.new : migration.old;
    }
    const [rel] = await q(
      `SELECT address, resolver FROM domain_resolver_relation WHERE "domainId" = $1 AND "chainId" = $2 AND ($3::text IS NULL OR lower(address) = $3) LIMIT 1`,
      [node, chainId, registry],
    );
    if (rel?.resolver && rel.resolver !== `0x${"00".repeat(20)}`) return { resolver: rel.resolver, exact: cursor === name };
    if (!cursor.includes(".")) return undefined;
    cursor = cursor.slice(cursor.indexOf(".") + 1);
  }
}

async function migrationInfo(chainId, node, leaf) {
  const [m] = await q(`SELECT controller, "blockNumber", timestamp, "transactionHash" FROM v2_migration WHERE id = $1 AND "chainId" = $2`, [node, chainId]);
  return {
    premigrated: leaf?.isPremigrated ?? false,
    migrated: Boolean(m) || (leaf?.isMigrated ?? false),
    migratedAt: m ? { block: m.blockNumber, timestamp: m.timestamp, transactionHash: m.transactionHash, controller: m.controller } : null,
  };
}

export async function resolveName(chainId, name, { coinTypes, texts } = {}) {
  const normalized = name.toLowerCase();
  const node = namehash(normalized);
  const v2 = await walkV2(chainId, normalized);
  const leaf = v2.leaf;
  const decision = decideAuthority({ leaf, resolver: v2.resolver, deployment: v2.deployment });
  const migration = await migrationInfo(chainId, node, leaf);

  if (decision.authority === "v2") {
    let records;
    if (decision.records === "v2") {
      records =
        (await recordsFromV2Resolver(chainId, v2.resolver, node, coinTypes, texts)) ??
        // Node-keyed resolvers: the v1 record tables hold every node-keyed record from any
        // address over full history; v2_node_* only since the ENSv2 start block, so it is
        // read last (a partial v2_node set would otherwise hide older records).
        (await recordsFromNodeResolver(chainId, v2.resolver, node, coinTypes, texts)) ??
        (await recordsFromV2NodeResolver(chainId, v2.resolver, node, coinTypes, texts));
    } else if (decision.records === "v1") {
      const v1 = await v1Resolver(chainId, normalized);
      records = v1 ? await recordsFromNodeResolver(chainId, v1.resolver, node, coinTypes, texts) : undefined;
    }
    return {
      name: normalized, node, chainId, protocol: "v2", authority: "v2", recordsFrom: decision.records, migration,
      registered: !decision.wildcard, owner: leaf?.owner ?? null, expiry: leaf?.expiry ?? null, status: leaf?.status ?? null,
      resolver: v2.resolver ?? null, exactResolver: v2.exact, ...(records ?? EMPTY_RECORDS),
    };
  }

  const v1 = await v1Resolver(chainId, normalized);
  const [domain] = await q(`SELECT "owner_id", "wrappedOwner_id", "expiryDate" FROM subgraph_domain WHERE id = $1 AND "chainId" = $2`, [node, chainId]);
  const records = v1 ? await recordsFromNodeResolver(chainId, v1.resolver, node, coinTypes, texts) : undefined;
  return {
    name: normalized, node, chainId, protocol: domain ? "v1" : null, authority: "v1", recordsFrom: "v1", migration,
    registered: Boolean(domain), owner: domain?.wrappedOwner_id ?? domain?.owner_id ?? null, expiry: domain?.expiryDate ?? null,
    status: domain ? "REGISTERED" : null, resolver: v1?.resolver ?? null, exactResolver: v1?.exact ?? false,
    ...(records ?? EMPTY_RECORDS),
  };
}

export async function primaryName(chainId, address, coinType = chainId === 1 ? 60 : undefined) {
  const addr = address.toLowerCase();
  const rows = await q(`SELECT "coinType", value FROM reverse_name_record WHERE address = $1 AND "chainId" = $2`, [addr, chainId]);
  const wanted = coinType === undefined ? rows : rows.filter((r) => String(r.coinType) === String(coinType));
  if (wanted.length === 0) return { address: addr, chainId, name: null, verified: false };
  const name = wanted[0].value;
  // Verify against the forward record of the reverse record's own coin type.
  const recordCoinType = String(wanted[0].coinType);
  const forward = await resolveName(chainId, name, { coinTypes: [recordCoinType] });
  const resolved = forward.addresses?.[recordCoinType];
  return { address: addr, chainId, name, coinType: recordCoinType, verified: resolved?.toLowerCase() === addr };
}
