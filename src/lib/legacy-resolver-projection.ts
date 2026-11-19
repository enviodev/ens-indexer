// ENSv2 resolver records in the legacy (subgraph-shaped) Resolver row, as the ENS
// subgraph does it (ensdomains/ens-subgraph 16846b1: src/ensv2ResolverProjection.ts
// loadEligibleLegacyResolver, attachDomainResolver, replaceLegacyResolverSnapshot,
// clearLegacyResolverSnapshot; called from src/ensv2Paths.ts and src/ensv2Resolver.ts).
//
// A Domain whose resolver is <resolver>-<node> gets a legacy Resolver row for it. If the
// resolver links the node to a record (PermissionedResolver), the row is a snapshot of
// that record: addr (the 20-byte coin type 60 address), coinTypes and texts (every key
// ever set, cleared ones included) and contentHash; Domain.resolvedAddress is the addr.
// An unlinked node (record 0) has an empty snapshot. A node-keyed resolver keeps the
// row its own events build, and Domain.resolvedAddress takes that row's addr.
import type { handlerContext } from "./helpers";
import { setDomain, upsertAccount, upsertResolver } from "./helpers";

const isAddress20 = (v: string | undefined) => v !== undefined && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Bring the legacy Resolver row for (resolver, node) in line with the ENSv2 record the
 * resolver links the node to. Does nothing unless the node's legacy Domain points at
 * this resolver (loadEligibleLegacyResolver).
 */
export async function refreshLegacyResolverSnapshot(
  context: handlerContext,
  chainId: number,
  resolverAddress: string,
  node: string,
): Promise<void> {
  const resolver = resolverAddress.toLowerCase();
  const resolverId = `${chainId}-${resolver}-${node}`;
  const domain = await context.Subgraph_domain.get(node);
  if (!domain || domain.resolver_id !== resolverId) return;
  const legacy = await upsertResolver(context, { id: resolverId, domain_id: node, address: resolver });

  const link = await context.V2_record_link.get(`${chainId}-${resolver}-${node}`);
  if (!link) {
    // Node-keyed resolver: its own events keep the row; carry its addr over.
    if (domain.resolvedAddress_id !== legacy.addr_id) setDomain(context, { ...domain, resolvedAddress_id: legacy.addr_id });
    return;
  }
  const record = link.active && !link.record_id.endsWith("-0") ? await context.V2_record.get(link.record_id) : undefined;
  if (!record) {
    context.Subgraph_resolver.set({ ...legacy, addr_id: undefined, contentHash: undefined, texts: undefined, coinTypes: undefined });
    if (domain.resolvedAddress_id !== undefined) setDomain(context, { ...domain, resolvedAddress_id: undefined });
    return;
  }
  const eth = (await context.V2_record_address.get(`${record.id}-60`))?.value;
  const addr = isAddress20(eth) ? eth!.toLowerCase() : undefined;
  if (addr) upsertAccount(context, addr);
  const coinTypes = record.coinTypesSeen && record.coinTypesSeen.length ? record.coinTypesSeen : undefined;
  const texts = record.textKeysSeen && record.textKeysSeen.length ? record.textKeysSeen : undefined;
  context.Subgraph_resolver.set({ ...legacy, addr_id: addr, contentHash: record.contenthash, coinTypes, texts });
  if (domain.resolvedAddress_id !== addr) setDomain(context, { ...domain, resolvedAddress_id: addr });
}

/** Refresh every node a record is linked to (projectRecordToActiveMemberships). */
export async function refreshRecordSnapshots(
  context: handlerContext,
  chainId: number,
  resolverAddress: string,
  recordId: string,
): Promise<void> {
  const links = (await context.V2_record_link.getWhere({ record_id: { _eq: recordId } })).filter((l) => l.active);
  for (const link of links) await refreshLegacyResolverSnapshot(context, chainId, resolverAddress, link.node);
}
