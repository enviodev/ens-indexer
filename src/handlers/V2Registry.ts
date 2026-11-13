import { indexer } from "envio";
import type { handlerContext } from "../lib/helpers";
import { ZERO_ADDRESS, hasNullByte, stripNullBytes } from "../lib/helpers";
import { isBatchRegistrar, isMigrationController, onV2Chains, seedKind } from "../lib/v2-deployments";
import { emitNameEvent } from "../lib/name-events";
import { syncLegacyProjection } from "../lib/legacy-projection";

// Every v2_domain write goes through here so the legacy projection follows it.
async function setV2Domain(
  context: handlerContext,
  event: { chainId: number; block: { number: number; timestamp: number } },
  row: V2Domain,
): Promise<void> {
  context.V2_domain.set(row);
  await syncLegacyProjection(context, event.chainId, row, event);
}
import {
  type V2Domain,
  ensureV2Registry,
  ensureV2Resolver,
  makeV2DomainId,
  makeV2EventId,
  makeV2RegistryId,
  nameInRegistry,
  nullableAddress,
  propagateV2Registry,
  setV2Edge,
  storageIdOf,
  toHex32,
} from "../lib/v2-helpers";

// ─── Discovery ───────────────────────────────────────────────────────────────
// Every ENSv2-specific event is matched on any address (wildcard), so no label,
// link or role change depends on when its contract was discovered. HyperIndex
// does not move a dynamic contract's start block earlier once it is set, and
// discovery events from different contracts can be handled out of block order,
// so address-based discovery alone loses events (seen on Sepolia).
//
// ERC-1155 transfers share their signature with every ERC-1155 token. They are
// matched on any address too, and applied only for an address that already has
// a v2_registry row: RegistryCreated, or any label, link or token event from the
// address, or a SubregistryUpdated pointing at it, creates one. Handlers run in
// log order, so this does not depend on fetch order. On Ethereum and Sepolia no
// registry emitted a transfer before its first such event.
//
// Matching proves nothing: names stay null until a proven parent links to it.

indexer.onEvent(
  { contract: "V2RegistryDiscovery", event: "RegistryCreated", wildcard: true, where: onV2Chains },
  async ({ event, context }) => {
    await ensureV2Registry(context, event.chainId, event.srcAddress, {
      block: event.block.number,
      timestamp: event.block.timestamp,
    });
  },
);


// ─── Labels ──────────────────────────────────────────────────────────────────

type Meta = { chainId: number; block: { number: number; timestamp: number }; srcAddress: string };

async function loadOrCreateDomain(
  event: Meta,
  context: handlerContext,
  tokenId: bigint,
): Promise<V2Domain> {
  const id = makeV2DomainId(event.chainId, event.srcAddress, tokenId);
  const existing = await context.V2_domain.get(id);
  if (existing) return existing;
  await ensureV2Registry(context, event.chainId, event.srcAddress);
  // Only reached when an event refers to a label we never saw registered.
  return {
    id,
    registry_id: makeV2RegistryId(event.chainId, event.srcAddress),
    storageId: toHex32(storageIdOf(tokenId)),
    tokenId,
    resource: undefined,
    labelhash: toHex32(storageIdOf(tokenId)),
    label: undefined,
    node: undefined,
    name: undefined,
    status: "UNREGISTERED",
    owner: undefined,
    expiry: undefined,
    subregistry: undefined,
    resolver: undefined,
    reservedBy: undefined,
    isPremigrated: false,
    isMigrated: false,
    migrationController: undefined,
    registrationCount: 0,
    createdBlock: event.block.number,
    createdTimestamp: BigInt(event.block.timestamp),
    registeredTimestamp: undefined,
    updatedBlock: event.block.number,
  };
}

interface LabelEvent {
  chainId: number;
  logIndex: number;
  block: { number: number; timestamp: number };
  srcAddress: string;
  transaction: { hash: string };
  params: {
    tokenId: bigint;
    labelHash: string;
    label: string;
    expiry: bigint;
    sender: string;
  };
}

async function handleLabel(
  event: LabelEvent,
  context: handlerContext,
  status: "RESERVED" | "REGISTERED",
  owner: string | undefined,
): Promise<void> {
  const { tokenId, labelHash, expiry, sender } = event.params;
  const label = hasNullByte(event.params.label) ? stripNullBytes(event.params.label) : event.params.label;
  const registry = await ensureV2Registry(context, event.chainId, event.srcAddress);
  const existing = await loadOrCreateDomain(event, context, tokenId);
  const { name, node } = nameInRegistry(registry, label, labelHash);

  const isReservedByBatch = status === "RESERVED" && isBatchRegistrar(event.chainId, sender);
  const isMigration = status === "REGISTERED" && isMigrationController(event.chainId, sender);

  // _register() rewrites subregistry and resolver. It emits an event only for
  // non-zero values, so clear what was here and let the events that follow fill it in.
  if (existing.subregistry) {
    await setV2Edge(context, event.chainId, existing.id, existing.subregistry, false, {
      block: event.block.number,
      timestamp: event.block.timestamp,
    });
  }

  await setV2Domain(context, event, {
    ...existing,
    tokenId,
    labelhash: labelHash,
    label,
    node,
    name,
    status,
    owner,
    expiry,
    subregistry: undefined,
    resolver: undefined,
    reservedBy: status === "RESERVED" ? sender.toLowerCase() : existing.reservedBy,
    isPremigrated: existing.isPremigrated || isReservedByBatch,
    isMigrated: existing.isMigrated || isMigration,
    migrationController: isMigration ? sender.toLowerCase() : existing.migrationController,
    registrationCount: existing.registrationCount + (status === "REGISTERED" ? 1 : 0),
    registeredTimestamp: status === "REGISTERED" ? BigInt(event.block.timestamp) : existing.registeredTimestamp,
    updatedBlock: event.block.number,
  });

  emitNameEvent(context, event, {
    kind: status === "REGISTERED" ? "REGISTRATION" : "RESERVATION",
    protocol: "v2",
    node,
    name,
    address: owner ?? sender,
    detail: { registry: event.srcAddress.toLowerCase(), tokenId, label, expiry, sender: sender.toLowerCase(), migration: isMigration },
  });

  if (isMigration && node && owner) {
    context.V2_migration.set({
      id: node,
      domain_id: existing.id,
      node,
      label,
      controller: sender.toLowerCase(),
      owner,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
      transactionHash: event.transaction.hash,
    });
  }
}

indexer.onEvent({ contract: "V2Registry", event: "LabelRegistered", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  await handleLabel(event, context, "REGISTERED", event.params.owner.toLowerCase());
});

indexer.onEvent({ contract: "V2Registry", event: "LabelReserved", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  await handleLabel(event, context, "RESERVED", undefined);
});

indexer.onEvent({ contract: "V2Registry", event: "LabelUnregistered", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const domain = await loadOrCreateDomain(event, context, event.params.tokenId);
  if (domain.subregistry) {
    await setV2Edge(context, event.chainId, domain.id, domain.subregistry, false, {
      block: event.block.number,
      timestamp: event.block.timestamp,
    });
  }
  emitNameEvent(context, event, {
    kind: "UNREGISTRATION", protocol: "v2", node: domain.node, name: domain.name,
    detail: { registry: event.srcAddress.toLowerCase(), tokenId: event.params.tokenId, sender: event.params.sender.toLowerCase() },
  });
  await setV2Domain(context, event, {
    ...domain,
    status: "UNREGISTERED",
    owner: undefined,
    expiry: BigInt(event.block.timestamp),
    updatedBlock: event.block.number,
  });
});

indexer.onEvent({ contract: "V2Registry", event: "ExpiryUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const domain = await loadOrCreateDomain(event, context, event.params.tokenId);
  emitNameEvent(context, event, {
    kind: "EXPIRY", protocol: "v2", node: domain.node, name: domain.name,
    detail: { registry: event.srcAddress.toLowerCase(), tokenId: event.params.tokenId, expiry: event.params.newExpiry },
  });
  await setV2Domain(context, event, {
    ...domain,
    expiry: event.params.newExpiry,
    updatedBlock: event.block.number,
  });
});

// ─── Links ───────────────────────────────────────────────────────────────────

indexer.onEvent({ contract: "V2Registry", event: "SubregistryUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { tokenId, subregistry, sender } = event.params;
  const meta = { block: event.block.number, timestamp: event.block.timestamp, sender: sender.toLowerCase() };
  const domain = await loadOrCreateDomain(event, context, tokenId);
  const next = nullableAddress(subregistry);

  const previous = domain.subregistry;
  await setV2Domain(context, event, { ...domain, subregistry: next, updatedBlock: event.block.number });
  emitNameEvent(context, event, {
    kind: "SUBREGISTRY", protocol: "v2", node: domain.node, name: domain.name, address: next,
    detail: { registry: event.srcAddress.toLowerCase(), tokenId, previous: previous ?? null },
  });

  if (previous && previous !== next) {
    await setV2Edge(context, event.chainId, domain.id, previous, false, meta);
  }
  if (next) {
    await ensureV2Registry(context, event.chainId, next);
    await setV2Edge(context, event.chainId, domain.id, next, true, meta);
  }
});

indexer.onEvent({ contract: "V2Registry", event: "ResolverUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { tokenId, resolver } = event.params;
  const domain = await loadOrCreateDomain(event, context, tokenId);
  const next = nullableAddress(resolver);
  await setV2Domain(context, event, { ...domain, resolver: next, updatedBlock: event.block.number });
  emitNameEvent(context, event, {
    kind: "RESOLVER", protocol: "v2", node: domain.node, name: domain.name, address: next,
    detail: { registry: event.srcAddress.toLowerCase(), tokenId, previous: domain.resolver ?? null },
  });
  if (next) {
    const registry = await context.V2_registry.get(domain.registry_id);
    await ensureV2Resolver(context, event.chainId, next, {
      discoveredVia: "ResolverUpdated",
      linkedBlock: event.block.number,
      proven: registry?.proven === true,
    });
  }
});

indexer.onEvent({ contract: "V2Registry", event: "ParentUpdated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const registry = await ensureV2Registry(context, event.chainId, event.srcAddress);
  context.V2_registry.set({
    ...registry,
    claimedParent: event.params.parent.toLowerCase(),
    claimedLabel: event.params.label,
  });
  await propagateV2Registry(context, event.chainId, event.srcAddress, 0, new Set(), event);
});

// ─── Tokens ──────────────────────────────────────────────────────────────────

indexer.onEvent({ contract: "V2Registry", event: "TokenResource", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { tokenId, resource } = event.params;
  const domain = await loadOrCreateDomain(event, context, tokenId);
  await setV2Domain(context, event, { ...domain, resource, updatedBlock: event.block.number });
  const registryId = makeV2RegistryId(event.chainId, event.srcAddress);
  context.V2_token_resource.set({
    id: `${registryId}-${tokenId}`,
    registry_id: registryId,
    domain_id: domain.id,
    tokenId,
    resource,
    regeneratedFrom: undefined,
    isCurrent: true,
  });
});

indexer.onEvent({ contract: "V2Registry", event: "TokenRegenerated", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  const { oldTokenId, newTokenId } = event.params;
  const registryId = makeV2RegistryId(event.chainId, event.srcAddress);
  const domain = await loadOrCreateDomain(event, context, oldTokenId);
  await setV2Domain(context, event, { ...domain, tokenId: newTokenId, updatedBlock: event.block.number });

  const oldMappingId = `${registryId}-${oldTokenId}`;
  const oldMapping = await context.V2_token_resource.get(oldMappingId);
  if (oldMapping) context.V2_token_resource.set({ ...oldMapping, isCurrent: false });

  context.V2_token_resource.set({
    id: `${registryId}-${newTokenId}`,
    registry_id: registryId,
    domain_id: domain.id,
    tokenId: newTokenId,
    resource: oldMapping?.resource ?? domain.resource ?? 0n,
    regeneratedFrom: oldTokenId,
    isCurrent: true,
  });

  context.V2_token_regeneration.set({
    id: makeV2EventId(event.chainId, event.block.number, event.logIndex),
    domain_id: domain.id,
    oldTokenId,
    newTokenId,
    resource: oldMapping?.resource ?? domain.resource,
    blockNumber: event.block.number,
    timestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
  });

  // _regenerate() burns, emits TokenRegenerated, then mints. The burn is the
  // log before this one, so it can be reclassified here: it was not a real burn.
  const burnId = makeV2EventId(event.chainId, event.block.number, event.logIndex - 1);
  const burn = await context.V2_transfer.get(burnId);
  if (burn && burn.tokenId === oldTokenId && burn.to === ZERO_ADDRESS) {
    context.V2_transfer.set({ ...burn, kind: "REGENERATION_BURN" });
  }
});

async function applyTransfer(
  event: {
    chainId: number;
    block: { number: number; timestamp: number };
    logIndex: number;
    srcAddress: string;
    transaction: { hash: string };
  },
  context: handlerContext,
  operator: string,
  from: string,
  to: string,
  tokenId: bigint,
  id: string,
): Promise<void> {
  const registryId = makeV2RegistryId(event.chainId, event.srcAddress);
  const domainId = makeV2DomainId(event.chainId, event.srcAddress, tokenId);
  const fromAddress = from.toLowerCase();
  const toAddress = to.toLowerCase();

  let kind: "MINT" | "BURN" | "TRANSFER" | "REGENERATION_MINT";
  if (fromAddress === ZERO_ADDRESS) {
    const mapping = await context.V2_token_resource.get(`${registryId}-${tokenId}`);
    kind = mapping?.regeneratedFrom !== undefined ? "REGENERATION_MINT" : "MINT";
  } else if (toAddress === ZERO_ADDRESS) {
    kind = "BURN";
  } else {
    kind = "TRANSFER";
  }

  const domain = await context.V2_domain.get(domainId);
  if (domain) {
    await setV2Domain(context, event, {
      ...domain,
      owner: toAddress === ZERO_ADDRESS ? undefined : toAddress,
      updatedBlock: event.block.number,
    });
  }

  context.V2_transfer.set({
    id,
    registry_id: registryId,
    domain_id: domain ? domainId : undefined,
    tokenId,
    from: fromAddress,
    to: toAddress,
    operator: operator.toLowerCase(),
    kind,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
  });
}

// Applied only for a known registry (a seed, or one with a v2_registry row); any
// other ERC-1155 token is skipped.
const isKnownRegistry = async (context: handlerContext, chainId: number, address: string) =>
  seedKind(chainId, address) !== undefined ||
  (await context.V2_registry.get(makeV2RegistryId(chainId, address))) !== undefined;

indexer.onEvent({ contract: "V2Registry", event: "TransferSingle", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  if (!(await isKnownRegistry(context, event.chainId, event.srcAddress))) return;
  const { operator, from, to, id } = event.params;
  await applyTransfer(event, context, operator, from, to, id, makeV2EventId(event.chainId, event.block.number, event.logIndex));
});

indexer.onEvent({ contract: "V2Registry", event: "TransferBatch", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
  if (!(await isKnownRegistry(context, event.chainId, event.srcAddress))) return;
  const { operator, from, to, ids } = event.params;
  for (const [i, id] of ids.entries()) {
    await applyTransfer(event, context, operator, from, to, id, `${makeV2EventId(event.chainId, event.block.number, event.logIndex)}-${i}`);
  }
});

// ─── Access control ──────────────────────────────────────────────────────────

indexer.onEvent({ contract: "V2Registry", event: "EACRolesChanged", wildcard: true, where: onV2Chains }, async ({ event, context }) => {
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
