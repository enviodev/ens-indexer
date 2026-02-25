import { ThreeDNSToken } from "generated";

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

// ─── Root Node Tracking ─────────────────────────────────────────────────────
// ThreeDNS lives on chains that may not have a Registry (e.g. Optimism).
// Ensure the root domain exists on the first event per chain.

const rootInitialized = new Set<number>();

async function ensureRoot(
  chainId: number,
  context: Parameters<Parameters<typeof ThreeDNSToken.NewOwner.handler>[0]>[0]["context"],
  timestamp: bigint,
): Promise<void> {
  if (!rootInitialized.has(chainId)) {
    rootInitialized.add(chainId);
    await ensureRootDomain(context, timestamp);
  }
}

// ─── ThreeDNSToken.NewOwner ─────────────────────────────────────────────────
// Creates/updates domain ownership. Sets the hardcoded ThreeDNS resolver
// on every domain since ThreeDNS doesn't use Registry.NewResolver.

ThreeDNSToken.NewOwner.handler(async ({ event, context }) => {
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

  const domain = await context.Domain.get(node);

  if (domain) {
    context.Domain.set({
      ...domain,
      owner_id: owner,
      resolver_id: resolverId,
      resolvedAddress_id: resolver.addr_id,
      isMigrated: true,
    });
  } else {
    // Create new domain
    const parent = await context.Domain.get(parentNode);
    const label = encodeLabelHash(labelHash);
    const name = parent?.name ? `${label}.${parent.name}` : label;

    context.Domain.set({
      id: node,
      name,
      labelName: undefined,
      labelhash: labelHash,
      parent_id: parentNode,
      subdomainCount: 0,
      resolvedAddress_id: resolver.addr_id,
      resolver_id: resolverId,
      ttl: undefined,
      isMigrated: true,
      createdAt: BigInt(event.block.timestamp),
      owner_id: owner,
      registrant_id: undefined,
      wrappedOwner_id: undefined,
      expiryDate: undefined,
    });

    // Increment parent's subdomain count
    if (parent) {
      context.Domain.set({
        ...parent,
        subdomainCount: parent.subdomainCount + 1,
      });
    }
  }

  // Garbage collect if owner is zero address
  if (owner === ZERO_ADDRESS) {
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  }

  // Log NewOwner event
  context.NewOwner.set({
    ...sharedEventValues(event.chainId, event),
    parentDomain_id: parentNode,
    domain_id: node,
    owner_id: owner,
  });
});

// ─── ThreeDNSToken.Transfer ─────────────────────────────────────────────────
// Updates domain ownership on ERC1155-style transfers.

ThreeDNSToken.Transfer.handler(async ({ event, context }) => {
  const { node, owner } = event.params;

  upsertAccount(context, owner);

  const domain = await context.Domain.get(node);
  if (domain) {
    context.Domain.set({
      ...domain,
      owner_id: owner,
    });
  }

  // Garbage collect if owner is zero address
  if (owner === ZERO_ADDRESS) {
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  }

  context.DomainTransfer.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    owner_id: owner,
  });
});

// ─── ThreeDNSToken.RegistrationCreated ──────────────────────────────────────
// Fired for TLD and 2LD registrations. Decodes the DNS-encoded FQDN to
// populate the domain's labelName and name, and creates a Registration entity.

ThreeDNSToken.RegistrationCreated.handler(async ({ event, context }) => {
  const { node, tld: parentNode, fqdn, registrant, expiry } = event.params;

  upsertAccount(context, registrant);

  // Decode DNS-encoded FQDN to get labels
  const labels = decodeDnsEncodedName(fqdn);
  const rawLabel = labels[0];

  // Compute labelHash and sanitize label
  let labelHash: string | undefined;
  let labelName: string | undefined;
  let fullName: string | undefined;

  if (rawLabel) {
    labelHash = keccak256(encodePacked(["string"], [rawLabel]));
    labelName = hasNullByte(rawLabel) ? stripNullBytes(rawLabel) : rawLabel;
    fullName = labels.join(".");
  }

  // Update domain with registration info
  const domain = await context.Domain.get(node);

  if (domain) {
    context.Domain.set({
      ...domain,
      labelName: labelName ?? domain.labelName,
      labelhash: labelHash ?? domain.labelhash,
      name: fullName ?? domain.name,
      registrant_id: registrant,
      expiryDate: expiry,
    });
  } else {
    // Domain wasn't created by a prior NewOwner — create it
    context.Domain.set({
      id: node,
      name: fullName,
      labelName,
      labelhash: labelHash,
      parent_id: parentNode,
      subdomainCount: 0,
      resolvedAddress_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      isMigrated: true,
      createdAt: BigInt(event.block.timestamp),
      owner_id: registrant,
      registrant_id: registrant,
      wrappedOwner_id: undefined,
      expiryDate: expiry,
    });
  }

  // Create/update Registration
  const registrationId = makeRegistrationId(labelHash ?? node, node);
  await upsertRegistration(context, {
    id: registrationId,
    domain_id: node,
    registrationDate: BigInt(event.block.timestamp),
    expiryDate: expiry,
    registrant_id: registrant,
    labelName,
  });

  // Log NameRegistered event
  context.NameRegisteredEvent.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    registrant_id: registrant,
    expiryDate: expiry,
  });
});

// ─── ThreeDNSToken.RegistrationExtended ─────────────────────────────────────
// Updates expiry dates on both Domain and Registration entities.

ThreeDNSToken.RegistrationExtended.handler(async ({ event, context }) => {
  const { node, newExpiry } = event.params;

  // Update domain expiry
  const domain = await context.Domain.get(node);
  if (domain) {
    context.Domain.set({
      ...domain,
      expiryDate: newExpiry,
    });
  }

  // Update registration expiry (registration ID = node)
  const registrationId = node;
  const registration = await context.Registration.get(registrationId);
  if (registration) {
    context.Registration.set({
      ...registration,
      expiryDate: newExpiry,
    });
  }

  // Log NameRenewed event
  context.NameRenewedEvent.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    expiryDate: newExpiry,
  });
});
