import { indexer } from "envio";
import type { handlerContext } from "../lib/helpers";

import {
  makeEventId,
  sharedEventValues,
  upsertAccount,
  bigintMax,
  MANAGED_NODES,
  tokenIdToLabelHash,
  indexableOrUndefined,
  isInterpretableLabel,
  decodeDnsEncodedName,
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
  const wrappedDomain = await context.Subgraph_wrapped_domain.get(node);
  if (!wrappedDomain) return;

  if (isPccFuseSet(wrappedDomain.fuses)) {
    const domain = await context.Subgraph_domain.get(node);
    if (domain) {
      context.Subgraph_domain.set({
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
    block: { number: number; timestamp: number };
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
  const domain = await context.Subgraph_domain.get(node);
  if (!domain) {
    context.log.error(
      `NameWrapper:handleTransfer called before domain '${node}' exists.`,
    );
    return;
  }

  // Upsert the WrappedDomain: if exists update owner, otherwise create with placeholders
  const existingWrapped = await context.Subgraph_wrapped_domain.get(node);
  if (existingWrapped) {
    context.Subgraph_wrapped_domain.set({
      ...existingWrapped,
      owner_id: to,
    });
  } else {
    context.Subgraph_wrapped_domain.set({
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
  context.Subgraph_domain.set({
    ...domain,
    wrappedOwner_id: to,
  });

  // Log WrappedTransfer event
  context.Subgraph_wrapped_transfer.set({
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
  const domain = await context.Subgraph_domain.get(node);
  if (!domain) {
    context.log.error(
      `NameWrapper:NameWrapped called before domain '${node}' exists.`,
    );
    return;
  }

  // The name param is the DNS wire-format name as a hex string.
  const labels = decodeDnsEncodedName(name);
  // Only trust the name if every label round-trips to the node.
  const decodedName: string | undefined =
    labels.length > 0 && labels.every(isInterpretableLabel)
      ? labels.join(".")
      : undefined;

  // Heal labelName and name if not already set. Only when the first label
  // round-trips to the node and the name fits an index.
  let updatedDomain = { ...domain };
  const label = labels[0];
  const healedName = indexableOrUndefined(decodedName);
  if (
    !domain.labelName &&
    label !== undefined &&
    isInterpretableLabel(label) &&
    healedName !== undefined &&
    indexableOrUndefined(label) !== undefined
  ) {
    updatedDomain = {
      ...updatedDomain,
      name: healedName,
      labelName: label,
    };
  }

  // Materialize wrappedOwner relation
  updatedDomain = {
    ...updatedDomain,
    wrappedOwner_id: owner,
  };
  context.Subgraph_domain.set(updatedDomain);

  // Update the WrappedDomain that was created in handleTransfer
  const fusesNum = Number(fuses);
  const existingWrapped = await context.Subgraph_wrapped_domain.get(node);
  if (existingWrapped) {
    context.Subgraph_wrapped_domain.set({
      ...existingWrapped,
      name: decodedName,
      expiryDate: expiry,
      fuses: fusesNum,
      isActive: true,
    });
  } else {
    // Fallback: create if handleTransfer didn't run first (shouldn't happen normally)
    context.Subgraph_wrapped_domain.set({
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
  context.Subgraph_name_wrapped.set({
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
  const domain = await context.Subgraph_domain.get(node);
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
  context.Subgraph_domain.set({
    ...domain,
    wrappedOwner_id: undefined,
    expiryDate,
  });

  // Delete the WrappedDomain
  context.Subgraph_wrapped_domain.deleteUnsafe(node);

  // Log NameUnwrapped
  context.Subgraph_name_unwrapped.set({
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
  const wrappedDomain = await context.Subgraph_wrapped_domain.get(node);
  if (wrappedDomain) {
    // Update fuses on the WrappedDomain
    context.Subgraph_wrapped_domain.set({
      ...wrappedDomain,
      fuses: fusesNum,
    });

    // Materialize domain expiryDate because fuses have potentially changed
    await materializeDomainExpiryDate(context, node);
  }

  // Log FusesSet (always logged, even if WrappedDomain doesn't exist)
  context.Subgraph_fuses_set.set({
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
  const wrappedDomain = await context.Subgraph_wrapped_domain.get(node);
  if (wrappedDomain) {
    // Update expiryDate on the WrappedDomain
    context.Subgraph_wrapped_domain.set({
      ...wrappedDomain,
      expiryDate: expiry,
    });

    // Materialize domain expiryDate
    await materializeDomainExpiryDate(context, node);
  }

  // Log ExpiryExtended (always logged, even if WrappedDomain doesn't exist)
  context.Subgraph_expiry_extended.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    expiryDate: expiry,
  });
  },
);
