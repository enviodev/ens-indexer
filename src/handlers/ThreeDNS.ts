import { indexer } from "envio";
import type { handlerContext } from "../lib/helpers";

import { keccak256, encodePacked } from "viem";

import {
  ROOT_NODE,
  ZERO_ADDRESS,
  THREEDNS_RESOLVER,
  makeSubdomainNode,
  makeResolverId,
  makeRegistrationId,
  encodeLabelHash,
  upsertAccount,
  upsertResolver,
  upsertRegistration,
  sharedEventValues,
  decodeDnsEncodedName,
  ensureRootDomain,
  recursivelyRemoveEmptyDomainFromParentSubdomainCount,
  hasNullByte,
  stripNullBytes,
} from "../lib/helpers";

import { upsertDomainResolverRelation } from "../lib/protocol-acceleration";

import {
  handleERC1155Transfer,
  buildDomainAssetId,
  AssetNamespaces,
} from "../lib/tokenscope-helpers";

// ─── Root Node Tracking ─────────────────────────────────────────────────────
// ThreeDNS lives on chains that may not have a Registry (e.g. Optimism).
// Ensure the root domain exists before any write. ensureRootDomain is
// idempotent via a DB lookup — a module-level Set must NOT be used here, as
// preload-pass writes are discarded and the Set would mask the real write.

async function ensureRoot(
  _chainId: number,
  context: handlerContext,
  _timestamp: bigint,
): Promise<void> {
  await ensureRootDomain(context);
}

// ─── ThreeDNSToken.NewOwner ─────────────────────────────────────────────────
// Creates/updates domain ownership. Sets the hardcoded ThreeDNS resolver
// on every domain since ThreeDNS doesn't use Registry.NewResolver.

indexer.onEvent(
  { contract: "ThreeDNSToken", event: "NewOwner" },
  async ({ event, context }) => {
  const { label: labelHash, node: parentNode, owner } = event.params;
  const node = makeSubdomainNode(labelHash, parentNode);

  await ensureRoot(event.chainId, context, BigInt(event.block.timestamp));

  upsertAccount(context, owner);

  // Set up hardcoded ThreeDNS resolver for this domain
  const resolverId = makeResolverId(event.chainId, THREEDNS_RESOLVER, node);
  const resolver = await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: THREEDNS_RESOLVER,
  });

  const domain = await context.subgraph_domains.get(node);

  if (domain) {
    context.subgraph_domains.set({
      ...domain,
      owner_id: owner,
      resolver_id: resolverId,
      resolved_address_id: resolver.addr_id,
      is_migrated: true,
    });
  } else {
    // Create new domain
    const parent = await context.subgraph_domains.get(parentNode);
    const label = encodeLabelHash(labelHash);
    const name = parent?.name ? `${label}.${parent.name}` : label;

    context.subgraph_domains.set({
      id: node,
      name,
      label_name: undefined,
      labelhash: labelHash,
      parent_id: parentNode,
      subdomain_count: 0,
      resolved_address_id: resolver.addr_id,
      resolver_id: resolverId,
      ttl: undefined,
      is_migrated: true,
      created_at: BigInt(event.block.timestamp),
      owner_id: owner,
      registrant_id: undefined,
      wrapped_owner_id: undefined,
      expiry_date: undefined,
    });

    // Increment parent's subdomain count
    if (parent) {
      context.subgraph_domains.set({
        ...parent,
        subdomain_count: parent.subdomain_count + 1,
      });
    }
  }

  // Garbage collect if owner is zero address
  if (owner === ZERO_ADDRESS) {
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  }

  // Log NewOwner event
  context.subgraph_new_owners.set({
    ...sharedEventValues(event.chainId, event),
    parent_domain_id: parentNode,
    domain_id: node,
    owner_id: owner,
  });

  // PA: track domain-resolver relationship for ThreeDNS
  upsertDomainResolverRelation(
    context,
    event.chainId,
    event.srcAddress,
    node,
    THREEDNS_RESOLVER,
  );
  },
);

// ─── ThreeDNSToken.Transfer ─────────────────────────────────────────────────
// Updates domain ownership on ERC1155-style transfers.

indexer.onEvent(
  { contract: "ThreeDNSToken", event: "Transfer" },
  async ({ event, context }) => {
  const { node, owner } = event.params;

  upsertAccount(context, owner);

  const domain = await context.subgraph_domains.get(node);
  if (domain) {
    context.subgraph_domains.set({
      ...domain,
      owner_id: owner,
    });
  }

  // Garbage collect if owner is zero address
  if (owner === ZERO_ADDRESS) {
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  }

  context.subgraph_transfers.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    owner_id: owner,
  });
  },
);

// ─── ThreeDNSToken.RegistrationCreated ──────────────────────────────────────
// Fired for TLD and 2LD registrations. Decodes the DNS-encoded FQDN to
// populate the domain's label_name and name, and creates a Registration entity.

indexer.onEvent(
  { contract: "ThreeDNSToken", event: "RegistrationCreated" },
  async ({ event, context }) => {
  const { node, tld: parentNode, fqdn, registrant, expiry } = event.params;

  upsertAccount(context, registrant);

  // Decode DNS-encoded FQDN to get labels
  const labels = decodeDnsEncodedName(fqdn);
  const rawLabel = labels[0];

  // Compute labelHash and sanitize label
  let labelHash: string | undefined;
  let label_name: string | undefined;
  let fullName: string | undefined;

  if (rawLabel) {
    labelHash = keccak256(encodePacked(["string"], [rawLabel]));
    label_name = hasNullByte(rawLabel) ? stripNullBytes(rawLabel) : rawLabel;
    fullName = labels.join(".");
  }

  // Update domain with registration info
  const domain = await context.subgraph_domains.get(node);

  if (domain) {
    context.subgraph_domains.set({
      ...domain,
      label_name: label_name ?? domain.label_name,
      labelhash: labelHash ?? domain.labelhash,
      name: fullName ?? domain.name,
      registrant_id: registrant,
      expiry_date: expiry,
    });
  } else {
    // Domain wasn't created by a prior NewOwner — create it
    context.subgraph_domains.set({
      id: node,
      name: fullName,
      label_name,
      labelhash: labelHash,
      parent_id: parentNode,
      subdomain_count: 0,
      resolved_address_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      is_migrated: true,
      created_at: BigInt(event.block.timestamp),
      owner_id: registrant,
      registrant_id: registrant,
      wrapped_owner_id: undefined,
      expiry_date: expiry,
    });
  }

  // Create/update Registration
  const registrationId = makeRegistrationId(labelHash ?? node, node);
  await upsertRegistration(context, {
    id: registrationId,
    domain_id: node,
    registration_date: BigInt(event.block.timestamp),
    expiry_date: expiry,
    registrant_id: registrant,
    label_name,
  });

  // Log NameRegistered event
  context.subgraph_name_registered.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    registrant_id: registrant,
    expiry_date: expiry,
  });
  },
);

// ─── ThreeDNSToken.RegistrationExtended ─────────────────────────────────────
// Updates expiry dates on both Domain and Registration entities.

indexer.onEvent(
  { contract: "ThreeDNSToken", event: "RegistrationExtended" },
  async ({ event, context }) => {
  const { node, newExpiry } = event.params;

  // Update domain expiry
  const domain = await context.subgraph_domains.get(node);
  if (domain) {
    context.subgraph_domains.set({
      ...domain,
      expiry_date: newExpiry,
    });
  }

  // Update registration expiry (registration ID = node)
  const registrationId = node;
  const registration = await context.subgraph_registrations.get(registrationId);
  if (registration) {
    context.subgraph_registrations.set({
      ...registration,
      expiry_date: newExpiry,
    });
  }

  // Log NameRenewed event
  context.subgraph_name_renewed.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    expiry_date: newExpiry,
  });
  },
);

// ─── ThreeDNSToken.TransferSingle (TokenScope: ERC1155 NFT tracking) ──────

indexer.onEvent(
  { contract: "ThreeDNSToken", event: "TransferSingle" },
  async ({ event, context }) => {
  const { id: tokenId, from, to, value } = event.params;

  // 3DNS allows non-standard minted remint (mint over already-minted token)
  const allowMintedRemint = true;

  const nft = buildDomainAssetId(
    event.chainId,
    event.srcAddress,
    tokenId,
    AssetNamespaces.ERC1155,
    (tid) => "0x" + tid.toString(16).padStart(64, "0"),
  );
  await handleERC1155Transfer(context, from, to, allowMintedRemint, nft, value);
  },
);

// ─── ThreeDNSToken.TransferBatch (TokenScope: ERC1155 NFT tracking) ───────

indexer.onEvent(
  { contract: "ThreeDNSToken", event: "TransferBatch" },
  async ({ event, context }) => {
  const { ids: tokenIds, values, from, to } = event.params;

  if (tokenIds.length !== values.length) {
    throw new Error(
      `ERC1155 transfer batch ids and values must have the same length, got ${tokenIds.length} and ${values.length}.`,
    );
  }

  // 3DNS allows non-standard minted remint (mint over already-minted token)
  const allowMintedRemint = true;

  for (let i = 0; i < tokenIds.length; i++) {
    const tokenId = tokenIds[i]!;
    const value = values[i]!;

    const nft = buildDomainAssetId(
      event.chainId,
      event.srcAddress,
      tokenId,
      AssetNamespaces.ERC1155,
      (tid) => "0x" + tid.toString(16).padStart(64, "0"),
    );
    await handleERC1155Transfer(context, from, to, allowMintedRemint, nft, value);
  }
  },
);
