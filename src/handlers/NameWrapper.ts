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

import { decodeInterpretedNameWrapperName } from "../lib/interpretation";

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
 * If the WrappedDomain has PCC fuse set, materialize the Domain's expiry_date
 * to the greater of its current expiry_date and the WrappedDomain's expiry_date.
 */
async function materializeDomainExpiryDate(
  context: handlerContext,
  node: string,
): Promise<void> {
  const wrappedDomain = await context.subgraph_wrapped_domains.get(node);
  if (!wrappedDomain) return;

  if (isPccFuseSet(wrappedDomain.fuses)) {
    const domain = await context.subgraph_domains.get(node);
    if (domain) {
      context.subgraph_domains.set({
        ...domain,
        expiry_date: bigintMax(domain.expiry_date ?? 0n, wrappedDomain.expiry_date),
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
  const domain = await context.subgraph_domains.get(node);
  if (!domain) {
    context.log.error(
      `NameWrapper:handleTransfer called before domain '${node}' exists.`,
    );
    return;
  }

  // Upsert the WrappedDomain: if exists update owner, otherwise create with placeholders
  const existingWrapped = await context.subgraph_wrapped_domains.get(node);
  if (existingWrapped) {
    context.subgraph_wrapped_domains.set({
      ...existingWrapped,
      owner_id: to,
    });
  } else {
    context.subgraph_wrapped_domains.set({
      id: node,
      domain_id: node,
      owner_id: to,
      expiry_date: 0n,
      fuses: 0,
      name: undefined,
    });
  }

  // Materialize Domain.wrapped_owner
  context.subgraph_domains.set({
    ...domain,
    wrapped_owner_id: to,
  });

  // Log WrappedTransfer event
  context.subgraph_wrapped_transfers.set({
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
  const domain = await context.subgraph_domains.get(node);
  if (!domain) {
    context.log.error(
      `NameWrapper:NameWrapped called before domain '${node}' exists.`,
    );
    return;
  }

  // The name param is a DNS-Encoded Literal Name. Decode + interpret it like
  // the reference (SUBGRAPH_COMPAT=false): each label kept if normalized,
  // otherwise replaced by its Encoded LabelHash; malformed packets → null.
  const decoded = decodeInterpretedNameWrapperName(name);
  const decodedName: string | undefined = decoded.name ?? undefined;
  const decodedLabel: string | undefined = decoded.label ?? undefined;

  // Update Domain label_name and name iff !domain.label_name && label
  // (truthy/falsy check intended, matching legacy subgraph logic)
  let updatedDomain = { ...domain };
  if (!domain.label_name && decodedLabel) {
    updatedDomain = {
      ...updatedDomain,
      name: decodedName,
      label_name: decodedLabel,
    };
  }

  // Materialize wrapped_owner relation
  updatedDomain = {
    ...updatedDomain,
    wrapped_owner_id: owner,
  };
  context.subgraph_domains.set(updatedDomain);

  // Update the WrappedDomain that was created in handleTransfer
  const fusesNum = Number(fuses);
  const existingWrapped = await context.subgraph_wrapped_domains.get(node);
  if (existingWrapped) {
    context.subgraph_wrapped_domains.set({
      ...existingWrapped,
      name: decodedName,
      expiry_date: expiry,
      fuses: fusesNum,
    });
  } else {
    // Fallback: create if handleTransfer didn't run first (shouldn't happen normally)
    context.subgraph_wrapped_domains.set({
      id: node,
      domain_id: node,
      owner_id: owner,
      name: decodedName,
      expiry_date: expiry,
      fuses: fusesNum,
    });
  }

  // Materialize domain expiry_date if PCC fuse is set
  await materializeDomainExpiryDate(context, node);

  // Log NameWrapped
  context.subgraph_name_wrapped.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    name: decodedName,
    fuses: fusesNum,
    owner_id: owner,
    expiry_date: expiry,
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
  const domain = await context.subgraph_domains.get(node);
  if (!domain) {
    context.log.error(
      `NameWrapper:NameUnwrapped called before domain '${node}' exists.`,
    );
    return;
  }

  // When unwrapping, reset any PCC-materialized expiry_date on the Domain entity.
  // If the domain's parent is a managed registrar node (e.g. ETH_NODE, LINEA_ETH_NODE),
  // it's a 2LD with a registration expiry — keep the domain's expiry_date.
  // Otherwise, clear it because it doesn't expire outside the wrapper.
  const expiry_date = (domain.parent_id && MANAGED_NODES.has(domain.parent_id)) ? domain.expiry_date : undefined;

  // Clear wrapped_owner and conditionally reset expiry_date
  context.subgraph_domains.set({
    ...domain,
    wrapped_owner_id: undefined,
    expiry_date,
  });

  // Delete the WrappedDomain
  context.subgraph_wrapped_domains.deleteUnsafe(node);

  // Log NameUnwrapped
  context.subgraph_name_unwrapped.set({
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
  const wrappedDomain = await context.subgraph_wrapped_domains.get(node);
  if (wrappedDomain) {
    // Update fuses on the WrappedDomain
    context.subgraph_wrapped_domains.set({
      ...wrappedDomain,
      fuses: fusesNum,
    });

    // Materialize domain expiry_date because fuses have potentially changed
    await materializeDomainExpiryDate(context, node);
  }

  // Log FusesSet (always logged, even if WrappedDomain doesn't exist)
  context.subgraph_fuses_set.set({
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
  const wrappedDomain = await context.subgraph_wrapped_domains.get(node);
  if (wrappedDomain) {
    // Update expiry_date on the WrappedDomain
    context.subgraph_wrapped_domains.set({
      ...wrappedDomain,
      expiry_date: expiry,
    });

    // Materialize domain expiry_date
    await materializeDomainExpiryDate(context, node);
  }

  // Log ExpiryExtended (always logged, even if WrappedDomain doesn't exist)
  context.subgraph_expiry_extended.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    expiry_date: expiry,
  });
  },
);
