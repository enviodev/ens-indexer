import { indexer } from "envio";
import type { handlerContext } from "../lib/helpers";

import {
  makeEventId,
  sharedEventValues,
  upsertAccount,
  bigintMax,
  MANAGED_NODES,
  tokenIdToLabelHash,
} from "../lib/helpers";

import {
  handleERC1155Transfer,
  buildDomainAssetId,
  AssetNamespaces,
} from "../lib/tokenscope-helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * PARENT_CANNOT_CONTROL (PCC) fuse bitmask.
 * When this fuse is SET (burned), the parent cannot control the subdomain.
 */
const PARENT_CANNOT_CONTROL = 0x10000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert an ERC1155 tokenId to the corresponding ENS node.
 * The NameWrapper's ERC1155 tokenIds ARE the namehash/node,
 * so we just need to pad to 32 bytes hex.
 */
function tokenIdToNode(tokenId: bigint): string {
  return "0x" + tokenId.toString(16).padStart(64, "0");
}

/**
 * Returns true if the PCC (PARENT_CANNOT_CONTROL) fuse is burned/set.
 */
function isPccFuseSet(fuses: number): boolean {
  return (fuses & PARENT_CANNOT_CONTROL) !== 0;
}

/**
 * If the WrappedDomain has PCC fuse set, materialize the Domain's expiryDate
 * to the greater of its current expiryDate and the WrappedDomain's expiryDate.
 */
async function materializeDomainExpiryDate(
  context: handlerContext,
  node: string,
): Promise<void> {
  const wrappedDomain = await context.WrappedDomain.get(node);
  if (!wrappedDomain) return;

  if (isPccFuseSet(wrappedDomain.fuses)) {
    const domain = await context.Domain.get(node);
    if (domain) {
      context.Domain.set({
        ...domain,
        expiryDate: bigintMax(domain.expiryDate ?? 0n, wrappedDomain.expiryDate),
      });
    }
  }
}

// ─── Shared Transfer Logic ──────────────────────────────────────────────────

/**
 * Shared logic for TransferSingle and TransferBatch handlers.
 * Processes a single token transfer within the NameWrapper.
 */
async function handleTransfer(
  event: {
    block: { number: number };
    logIndex: number;
    transaction: { hash: string };
    chainId: number;
  },
  context: handlerContext,
  eventId: string,
  tokenId: bigint,
  to: string,
): Promise<void> {
  const node = tokenIdToNode(tokenId);

  // Upsert account for the recipient
  upsertAccount(context, to);

  // Domain must already exist (created by Registry NewOwner event)
  const domain = await context.Domain.get(node);
  if (!domain) {
    context.log.error(
      `NameWrapper:handleTransfer called before domain '${node}' exists.`,
    );
    return;
  }

  // Upsert the WrappedDomain: if exists update owner, otherwise create with placeholders
  const existingWrapped = await context.WrappedDomain.get(node);
  if (existingWrapped) {
    context.WrappedDomain.set({
      ...existingWrapped,
      owner_id: to,
    });
  } else {
    context.WrappedDomain.set({
      id: node,
      domain_id: node,
      owner_id: to,
      expiryDate: 0n,
      fuses: 0,
      name: undefined,
      isActive: true,
    });
  }

  // Materialize Domain.wrappedOwner
  context.Domain.set({
    ...domain,
    wrappedOwner_id: to,
  });

  // Log WrappedTransfer event
  context.WrappedTransfer.set({
    ...sharedEventValues(event.chainId, event),
    id: eventId,
    domain_id: node,
    owner_id: to,
  });
}

// ─── TransferSingle ─────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "NameWrapper", event: "TransferSingle" },
  async ({ event, context }) => {
  const { id: tokenId, to, from, value } = event.params;

  await handleTransfer(
    event,
    context,
    makeEventId(event.chainId, event.block.number, event.logIndex, 0),
    tokenId,
    to,
  );

  // TokenScope: track ERC1155 transfer
  const nft = buildDomainAssetId(
    event.chainId,
    event.srcAddress,
    tokenId,
    AssetNamespaces.ERC1155,
    (tid) => "0x" + tid.toString(16).padStart(64, "0"),
  );
  await handleERC1155Transfer(context, from, to, false, nft, value);
  },
);

// ─── TransferBatch ──────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "NameWrapper", event: "TransferBatch" },
  async ({ event, context }) => {
  const { ids: tokenIds, values, to, from } = event.params;

  for (let i = 0; i < tokenIds.length; i++) {
    const tokenId = tokenIds[i]!;
    const value = values[i]!;
    await handleTransfer(
      event,
      context,
      makeEventId(event.chainId, event.block.number, event.logIndex, i),
      tokenId,
      to,
    );

    // TokenScope: track ERC1155 transfer for each token
    const nft = buildDomainAssetId(
      event.chainId,
      event.srcAddress,
      tokenId,
      AssetNamespaces.ERC1155,
      (tid) => "0x" + tid.toString(16).padStart(64, "0"),
    );
    await handleERC1155Transfer(context, from, to, false, nft, value);
  }
  },
);

// ─── NameWrapped ────────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "NameWrapper", event: "NameWrapped" },
  async ({ event, context }) => {
  const { node, name, owner, fuses, expiry } = event.params;

  // Upsert account for the owner
  upsertAccount(context, owner);

  // Domain must already exist
  const domain = await context.Domain.get(node);
  if (!domain) {
    context.log.error(
      `NameWrapper:NameWrapped called before domain '${node}' exists.`,
    );
    return;
  }

  // The name param is DNS-encoded bytes as hex string.
  // For the initial migration, we store the raw hex name or undefined.
  // A proper implementation would decode DNS-encoded names here.
  const decodedName: string | undefined = name || undefined;

  // Update Domain labelName and name if not already set
  // This matches the subgraph behavior: only heal if !domain.labelName && label
  let updatedDomain = { ...domain };
  if (!domain.labelName && decodedName) {
    updatedDomain = {
      ...updatedDomain,
      name: decodedName,
      // labelName would ideally be extracted from DNS decoding;
      // for now we leave it as-is since we don't decode DNS names
    };
  }

  // Materialize wrappedOwner relation
  updatedDomain = {
    ...updatedDomain,
    wrappedOwner_id: owner,
  };
  context.Domain.set(updatedDomain);

  // Update the WrappedDomain that was created in handleTransfer
  const fusesNum = Number(fuses);
  const existingWrapped = await context.WrappedDomain.get(node);
  if (existingWrapped) {
    context.WrappedDomain.set({
      ...existingWrapped,
      name: decodedName,
      expiryDate: expiry,
      fuses: fusesNum,
      isActive: true,
    });
  } else {
    // Fallback: create if handleTransfer didn't run first (shouldn't happen normally)
    context.WrappedDomain.set({
      id: node,
      domain_id: node,
      owner_id: owner,
      name: decodedName,
      expiryDate: expiry,
      fuses: fusesNum,
      isActive: true,
    });
  }

  // Materialize domain expiryDate if PCC fuse is set
  await materializeDomainExpiryDate(context, node);

  // Log NameWrapped
  context.NameWrapped.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    name: decodedName,
    fuses: fusesNum,
    owner_id: owner,
    expiryDate: expiry,
  });
  },
);

// ─── NameUnwrapped ──────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "NameWrapper", event: "NameUnwrapped" },
  async ({ event, context }) => {
  const { node, owner } = event.params;

  // Upsert account for the owner
  upsertAccount(context, owner);

  // Get the domain
  const domain = await context.Domain.get(node);
  if (!domain) {
    context.log.error(
      `NameWrapper:NameUnwrapped called before domain '${node}' exists.`,
    );
    return;
  }

  // When unwrapping, reset any PCC-materialized expiryDate on the Domain entity.
  // If the domain's parent is a managed registrar node (e.g. ETH_NODE, LINEA_ETH_NODE),
  // it's a 2LD with a registration expiry — keep the domain's expiryDate.
  // Otherwise, clear it because it doesn't expire outside the wrapper.
  const expiryDate = (domain.parent_id && MANAGED_NODES.has(domain.parent_id)) ? domain.expiryDate : undefined;

  // Clear wrappedOwner and conditionally reset expiryDate
  context.Domain.set({
    ...domain,
    wrappedOwner_id: undefined,
    expiryDate,
  });

  // Delete the WrappedDomain
  context.WrappedDomain.deleteUnsafe(node);

  // Log NameUnwrappedEvent
  context.NameUnwrappedEvent.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    owner_id: owner,
  });
  },
);

// ─── FusesSet ───────────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "NameWrapper", event: "FusesSet" },
  async ({ event, context }) => {
  const { node, fuses } = event.params;
  const fusesNum = Number(fuses);

  // Only update if the WrappedDomain exists and is active
  const wrappedDomain = await context.WrappedDomain.get(node);
  if (wrappedDomain) {
    // Update fuses on the WrappedDomain
    context.WrappedDomain.set({
      ...wrappedDomain,
      fuses: fusesNum,
    });

    // Materialize domain expiryDate because fuses have potentially changed
    await materializeDomainExpiryDate(context, node);
  }

  // Log FusesSetEvent (always logged, even if WrappedDomain doesn't exist)
  context.FusesSetEvent.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    fuses: fusesNum,
  });
  },
);

// ─── ExpiryExtended ─────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "NameWrapper", event: "ExpiryExtended" },
  async ({ event, context }) => {
  const { node, expiry } = event.params;

  // Only update if the WrappedDomain exists and is active
  const wrappedDomain = await context.WrappedDomain.get(node);
  if (wrappedDomain) {
    // Update expiryDate on the WrappedDomain
    context.WrappedDomain.set({
      ...wrappedDomain,
      expiryDate: expiry,
    });

    // Materialize domain expiryDate
    await materializeDomainExpiryDate(context, node);
  }

  // Log ExpiryExtendedEvent (always logged, even if WrappedDomain doesn't exist)
  context.ExpiryExtendedEvent.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    expiryDate: expiry,
  });
  },
);
