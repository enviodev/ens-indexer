import { indexer } from "envio";
import { decodeDnsEncodedName, namehashFromLabels, type handlerContext } from "../lib/helpers";
import { ensureV2Resolver, makeV2RegistryId } from "../lib/v2-helpers";

// ─── Discovery ───────────────────────────────────────────────────────────────
// As with registries: watch every resolver from creation so records written in
// initialize(), before any registry links to it, are kept.

indexer.contractRegister(
  { contract: "V2ResolverDiscovery", event: "ResolverCreated", wildcard: true },
  async ({ event, context }) => {
    context.chain.V2Resolver.add(event.srcAddress as `0x${string}`);
    context.chain.Resolver.add(event.srcAddress as `0x${string}`);
  },
);

indexer.onEvent(
  { contract: "V2ResolverDiscovery", event: "ResolverCreated", wildcard: true },
  async ({ event, context }) => {
    await ensureV2Resolver(context, event.chainId, event.srcAddress, {
      discoveredVia: "ResolverCreated",
      createdBlock: event.block.number,
    });
  },
);

function recordRowId(resolverId: string, recordId: bigint): string {
  return `${resolverId}-${recordId}`;
}

function decodeName(encoded: string): string | undefined {
  try {
    return decodeDnsEncodedName(encoded).join(".");
  } catch {
    return undefined;
  }
}

function nodeOf(encoded: string): string {
  return namehashFromLabels(decodeDnsEncodedName(encoded));
}

async function ensureRecord(context: handlerContext, chainId: number, resolver: string, recordId: bigint) {
  await ensureV2Resolver(context, chainId, resolver, { discoveredVia: "ResolverCreated" });
  const resolverId = makeV2RegistryId(chainId, resolver);
  const id = recordRowId(resolverId, recordId);
  const existing = await context.V2_record.get(id);
  if (existing) return existing;
  const row = { id, resolver_id: resolverId, recordId, contenthash: undefined, primaryName: undefined };
  context.V2_record.set(row);
  return row;
}

indexer.onEvent({ contract: "V2Resolver", event: "Linked" }, async ({ event, context }) => {
  const { recordId, node, name } = event.params;
  const resolverId = makeV2RegistryId(event.chainId, event.srcAddress);
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  context.V2_record_link.set({
    id: `${resolverId}-${node}`,
    resolver_id: resolverId,
    record_id: record.id,
    node,
    name: decodeName(name),
    active: true,
    updatedBlock: event.block.number,
  });
});

indexer.onEvent({ contract: "V2Resolver", event: "Cleared" }, async ({ event, context }) => {
  const resolverId = makeV2RegistryId(event.chainId, event.srcAddress);
  const id = recordRowId(resolverId, event.params.recordId);
  const record = await context.V2_record.get(id);
  if (!record) return;
  context.V2_record.set({ ...record, contenthash: undefined, primaryName: undefined });
  for (const row of await context.V2_record_text.getWhere({ record_id: { _eq: id } })) {
    context.V2_record_text.deleteUnsafe(row.id);
  }
  for (const row of await context.V2_record_address.getWhere({ record_id: { _eq: id } })) {
    context.V2_record_address.deleteUnsafe(row.id);
  }
});

indexer.onEvent({ contract: "V2Resolver", event: "AddressUpdated" }, async ({ event, context }) => {
  const { recordId, coinType, addressBytes } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  const id = `${record.id}-${coinType}`;
  if (addressBytes === "0x") {
    context.V2_record_address.deleteUnsafe(id);
    return;
  }
  context.V2_record_address.set({ id, record_id: record.id, coinType, value: addressBytes });
});

indexer.onEvent({ contract: "V2Resolver", event: "TextUpdated" }, async ({ event, context }) => {
  const { recordId, key, value } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  const id = `${record.id}-${key}`;
  if (value === "") {
    context.V2_record_text.deleteUnsafe(id);
    return;
  }
  context.V2_record_text.set({ id, record_id: record.id, key, value });
});

indexer.onEvent({ contract: "V2Resolver", event: "ContenthashUpdated" }, async ({ event, context }) => {
  const { recordId, hash } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  context.V2_record.set({ ...record, contenthash: hash === "0x" ? undefined : hash });
});

indexer.onEvent({ contract: "V2Resolver", event: "NameUpdated" }, async ({ event, context }) => {
  const { recordId, primaryName } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  context.V2_record.set({ ...record, primaryName: primaryName === "" ? undefined : primaryName });
});

indexer.onEvent({ contract: "V2Resolver", event: "EACRolesChanged" }, async ({ event, context }) => {
  const { resource, account, newRoleBitmap } = event.params;
  const contract = event.srcAddress.toLowerCase();
  const holder = account.toLowerCase();
  context.V2_permission.set({
    id: `${event.chainId}-${contract}-${resource}-${holder}`,
    contract,
    resource,
    account: holder,
    roles: newRoleBitmap,
    active: newRoleBitmap !== 0n,
    updatedBlock: event.block.number,
  });
});

// Deployments before 2026-09 aliased through AliasChanged; the current ones use Linked.
indexer.onEvent({ contract: "V2Resolver", event: "AliasChanged" }, async ({ event, context }) => {
  const { fromName, toName } = event.params;
  const resolverId = makeV2RegistryId(event.chainId, event.srcAddress);
  await ensureV2Resolver(context, event.chainId, event.srcAddress, { discoveredVia: "ResolverCreated" });
  const fromNode = nodeOf(fromName);
  const empty = toName === "0x";
  context.V2_alias.set({
    id: `${resolverId}-${fromNode}`,
    resolver_id: resolverId,
    fromNode,
    fromName: decodeName(fromName),
    toNode: empty ? undefined : nodeOf(toName),
    toName: empty ? undefined : decodeName(toName),
    updatedBlock: event.block.number,
  });
});
