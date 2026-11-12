import { indexer } from "envio";
import { onV2Chains } from "../lib/v2-deployments";
import { decodeDnsEncodedName, namehashFromLabels, type handlerContext } from "../lib/helpers";
import { ensureV2Resolver, makeV2RegistryId, nullableAddress } from "../lib/v2-helpers";
import { emitNameEvent } from "../lib/name-events";

// ─── Discovery ───────────────────────────────────────────────────────────────
// Record events are matched on any address (wildcard), so records written before
// a registry links the resolver are kept regardless of discovery order. A
// resolver is trusted only once a proven registry points at it.

indexer.onEvent(
  { contract: "V2ResolverDiscovery", event: "ResolverCreated", wildcard: true, where: onV2Chains },
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

// A record can back several names (aliases): emit one change per linked name.
async function emitRecordChange(
  context: handlerContext,
  event: { chainId: number; srcAddress: string; block: { number: number; timestamp: number }; logIndex: number; transaction: { hash: string } },
  recordRowId: string,
  detail: Record<string, unknown>,
) {
  const links = (await context.V2_record_link.getWhere({ record_id: { _eq: recordRowId } })).filter((l) => l.active);
  const resolver = event.srcAddress.toLowerCase();
  if (links.length === 0) {
    emitNameEvent(context, event, { kind: "RECORD", protocol: "v2", address: resolver, detail: { resolver, record: recordRowId, ...detail } });
    return;
  }
  links.forEach((l, i) =>
    emitNameEvent(context, event, { kind: "RECORD", protocol: "v2", node: l.node, name: l.name, address: resolver, seq: i, detail: { resolver, record: recordRowId, ...detail } }),
  );
}

indexer.onEvent({ contract: "V2Resolver", event: "Linked", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { recordId, node, name } = event.params;
  const resolverId = makeV2RegistryId(event.chainId, event.srcAddress);
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  emitNameEvent(context, event, {
    kind: "ALIAS", protocol: "v2", node, name: decodeName(name), address: event.srcAddress,
    detail: { resolver: event.srcAddress.toLowerCase(), record: record.id },
  });
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

indexer.onEvent({ contract: "V2Resolver", event: "Cleared", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
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
  for (const row of await context.V2_record_data.getWhere({ record_id: { _eq: id } })) {
    context.V2_record_data.deleteUnsafe(row.id);
  }
  for (const row of await context.V2_record_abi.getWhere({ record_id: { _eq: id } })) {
    context.V2_record_abi.deleteUnsafe(row.id);
  }
  for (const row of await context.V2_record_interface.getWhere({ record_id: { _eq: id } })) {
    context.V2_record_interface.deleteUnsafe(row.id);
  }
});

indexer.onEvent({ contract: "V2Resolver", event: "AddressUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { recordId, coinType, addressBytes } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  const id = `${record.id}-${coinType}`;
  if (addressBytes === "0x") {
    context.V2_record_address.deleteUnsafe(id);
    await emitRecordChange(context, event, record.id, { field: "address", coinType, value: null });
    return;
  }
  context.V2_record_address.set({ id, record_id: record.id, coinType, value: addressBytes });
  await emitRecordChange(context, event, record.id, { field: "address", coinType, value: addressBytes });
});

indexer.onEvent({ contract: "V2Resolver", event: "TextUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { recordId, key, value } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  const id = `${record.id}-${key}`;
  if (value === "") {
    context.V2_record_text.deleteUnsafe(id);
    await emitRecordChange(context, event, record.id, { field: "text", key, value: null });
    return;
  }
  context.V2_record_text.set({ id, record_id: record.id, key, value });
  await emitRecordChange(context, event, record.id, { field: "text", key, value });
});

indexer.onEvent({ contract: "V2Resolver", event: "ContenthashUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { recordId, hash } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  context.V2_record.set({ ...record, contenthash: hash === "0x" ? undefined : hash });
  await emitRecordChange(context, event, record.id, { field: "contenthash", value: hash === "0x" ? null : hash });
});

indexer.onEvent({ contract: "V2Resolver", event: "NameUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { recordId, primaryName } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  context.V2_record.set({ ...record, primaryName: primaryName === "" ? undefined : primaryName });
  await emitRecordChange(context, event, record.id, { field: "name", value: primaryName === "" ? null : primaryName });
});

indexer.onEvent({ contract: "V2Resolver", event: "DataUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { recordId, key, value } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  const id = `${record.id}-${key}`;
  if (value === "0x") {
    context.V2_record_data.deleteUnsafe(id);
    return;
  }
  context.V2_record_data.set({ id, record_id: record.id, key, value });
});

indexer.onEvent({ contract: "V2Resolver", event: "ABIUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { recordId, contentType } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  context.V2_record_abi.set({
    id: `${record.id}-${contentType}`,
    record_id: record.id,
    contentType,
    blockNumber: event.block.number,
  });
});

indexer.onEvent({ contract: "V2Resolver", event: "InterfaceUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { recordId, interfaceId, implementer } = event.params;
  const record = await ensureRecord(context, event.chainId, event.srcAddress, recordId);
  context.V2_record_interface.set({
    id: `${record.id}-${interfaceId}`,
    record_id: record.id,
    interfaceId,
    implementer: nullableAddress(implementer),
  });
});

// EACRolesChanged on resolvers is handled by the V2Registry wildcard handler:
// one signature, one handler, whichever contract emitted it.

// Deployments before 2026-09 aliased through AliasChanged; the current ones use Linked.
indexer.onEvent({ contract: "V2Resolver", event: "AliasChanged", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
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
