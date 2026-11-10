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

export async function resolveName(chainId, name, { coinTypes, texts } = {}) {
  const normalized = name.toLowerCase();
  const node = namehash(normalized);
  const v2 = await walkV2(chainId, normalized);
  const mirror = v2.deployment ? v2.deployment.v1Mirror.includes(v2.resolver) : false;

  if (v2.found && v2.resolver && !mirror && !(v2.deployment?.v2Mirror.includes(v2.resolver))) {
    const records =
      (await recordsFromV2Resolver(chainId, v2.resolver, node, coinTypes, texts)) ??
      (await recordsFromNodeResolver(chainId, v2.resolver, node, coinTypes, texts));
    return {
      name: normalized, node, chainId, protocol: "v2",
      registered: Boolean(v2.leaf), owner: v2.leaf?.owner ?? null, expiry: v2.leaf?.expiry ?? null,
      status: v2.leaf?.status ?? null, resolver: v2.resolver, exactResolver: v2.exact,
      ...(records ?? { addresses: {}, texts: {}, contenthash: null, recordSource: "none" }),
    };
  }

  const v1 = await v1Resolver(chainId, normalized);
  const [domain] = await q(`SELECT "owner_id", "wrappedOwner_id", "expiryDate" FROM subgraph_domain WHERE id = $1 AND "chainId" = $2`, [node, chainId]);
  const records = v1 ? await recordsFromNodeResolver(chainId, v1.resolver, node, coinTypes, texts) : undefined;
  return {
    name: normalized, node, chainId, protocol: "v1",
    registered: Boolean(domain), owner: domain?.wrappedOwner_id ?? domain?.owner_id ?? null, expiry: domain?.expiryDate ?? null,
    status: domain ? "REGISTERED" : null, resolver: v1?.resolver ?? null, exactResolver: v1?.exact ?? false,
    ...(records ?? { addresses: {}, texts: {}, contenthash: null, recordSource: "none" }),
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
