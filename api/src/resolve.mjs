// Name resolution from indexed state. Mirrors LibResolution.findResolver: walk
// from the root registry, remember the deepest resolver, stop where a registry
// has no subregistry. Expired entries read as empty, as in the contracts.
import { keccak256, toBytes, concat } from "viem";
import { q } from "./db.mjs";

export const DEPLOYMENTS = {
  1: { root: "0x2553c09be6447beffdb86fa622ad41fb8f77a91e", v1Mirror: ["0x394d8eb4a4fdf599384deab25f31d111d755c398"], v2Mirror: ["0x3071ad643ce4ed8b3d67b289845b45db82b068a4"] },
  11155111: { root: "0xb458d6a3a77919449d03e7a6903c26827c1ec43f", v1Mirror: ["0x322b7581ca210a69c6d0e0d7c88a7688d2789cb0"], v2Mirror: ["0x1cf3989ed3e5ec3cb1d731fc3777323813b61acf"] },
};

const ROOT = `0x${"00".repeat(32)}`;
const EMPTY_RECORDS = { addresses: {}, texts: {}, contenthash: null, recordSource: "none" };
const labelhash = (l) => keccak256(toBytes(l));
const storageId = (hash) => `0x${(BigInt(hash) & ~0xffffffffn).toString(16).padStart(64, "0")}`;

export function namehash(name) {
  let node = ROOT;
  if (name === "") return node;
  for (const label of name.split(".").reverse()) node = keccak256(concat([node, labelhash(label)]));
  return node;
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

async function v1Resolver(chainId, name) {
  let cursor = name;
  for (;;) {
    const node = namehash(cursor);
    const [rel] = await q(`SELECT address, resolver FROM domain_resolver_relation WHERE "domainId" = $1 AND "chainId" = $2 LIMIT 1`, [node, chainId]);
    if (rel?.resolver && rel.resolver !== `0x${"00".repeat(20)}`) return { resolver: rel.resolver, exact: cursor === name };
    if (!cursor.includes(".")) return undefined;
    cursor = cursor.slice(cursor.indexOf(".") + 1);
  }
}

/**
 * Which protocol answers for a name, from the ENSv2 walk alone.
 *
 * - A name registered on v2 is answered by v2. If its resolver only mirrors
 *   v1 (ENSV1Resolver), its records still come from v1.
 * - A name only reserved on v2 (premigration) is still answered by v1, unless
 *   its owner has set a real v2 resolver.
 * - With no exact entry, a v2 ancestor's resolver answers (wildcard).
 * - Otherwise v1 answers.
 */
export function decideAuthority({ leaf, resolver, deployment }) {
  const v1Mirror = deployment?.v1Mirror.includes(resolver) ?? false;
  const v2Mirror = deployment?.v2Mirror.includes(resolver) ?? false;
  const realV2Resolver = Boolean(resolver) && !v1Mirror && !v2Mirror;
  if (leaf && (leaf.status === "REGISTERED" || (leaf.status === "RESERVED" && realV2Resolver))) {
    return { authority: "v2", records: realV2Resolver ? "v2" : v1Mirror ? "v1" : "none", wildcard: false };
  }
  if (!leaf && realV2Resolver) return { authority: "v2", records: "v2", wildcard: true };
  return { authority: "v1", records: "v1", wildcard: false, reason: leaf?.status === "RESERVED" ? "reserved on v2, not migrated" : "not on v2" };
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
        (await recordsFromV2NodeResolver(chainId, v2.resolver, node, coinTypes, texts)) ??
        (await recordsFromNodeResolver(chainId, v2.resolver, node, coinTypes, texts));
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
  const forward = await resolveName(chainId, name, { coinTypes: [String(coinType ?? 60)] });
  const resolved = Object.values(forward.addresses ?? {})[0];
  return { address: addr, chainId, name, coinType: String(wanted[0].coinType), verified: resolved?.toLowerCase() === addr };
}
