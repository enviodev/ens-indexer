import { indexer } from "envio";
import type { handlerContext } from "../lib/helpers";

import {
  makeSubdomainNode,
  ROOT_NODE,
  ZERO_ADDRESS,
  ETH_NODE,
  encodeLabelHash,
  upsertAccount,
  makeResolverId,
  upsertResolver,
  sharedEventValues,
  recursivelyRemoveEmptyDomainFromParentSubdomainCount,
  makeEventId,
  ensureRootDomain,
} from "../lib/helpers";

import {
  upsertDomainResolverRelation,
  migrateNode,
  nodeIsMigrated,
} from "../lib/protocol-acceleration";

// ─── Root Node Initialization ────────────────────────────────────────────────
// We track whether the root node has been created so we can initialize it on
// the very first NewOwner event from the old registry.

const rootNodeInitializedChains = new Set<number>();

// ─── Dynamic Contract Registration ──────────────────────────────────────────
// Register Resolver contract addresses dynamically from NewResolver events so
// that the Resolver handler can process events from those addresses.

indexer.contractRegister(
  { contract: "RegistryOld", event: "NewResolver" },
  async ({ event, context }) => {
    if (event.params.resolver !== ZERO_ADDRESS) {
      context.chain.Resolver.add(event.params.resolver as `0x${string}`);
    }
  },
);

indexer.contractRegister(
  { contract: "Registry", event: "NewResolver" },
  async ({ event, context }) => {
    if (event.params.resolver !== ZERO_ADDRESS) {
      context.chain.Resolver.add(event.params.resolver as `0x${string}`);
    }
  },
);

// ─── Shared NewOwner Handler ────────────────────────────────────────────────

async function handleNewOwner(
  event: {
    params: { node: string; label: string; owner: string };
    block: { number: number; timestamp: number };
    logIndex: number;
    transaction: { hash: string };
    srcAddress: string;
  },
  context: handlerContext,
  isMigrated: boolean,
): Promise<void> {
  const { label: labelHash, node: parentNode, owner } = event.params;

  // Compute the subdomain node from labelHash + parentNode
  const node = makeSubdomainNode(labelHash, parentNode);

  // Ensure the root domain exists on the first event per chain
  if (!rootNodeInitializedChains.has(event.chainId)) {
    rootNodeInitializedChains.add(event.chainId);
    await ensureRootDomain(context, BigInt(event.block.timestamp));
  }

  // Upsert account for the new owner
  upsertAccount(context, owner);

  // Load existing domain
  const domain = await context.subgraph_domain.get(node);

  if (domain) {
    // For the old registry (isMigrated=false): if the domain has already been
    // migrated to the new registry, skip this event entirely.
    if (!isMigrated && domain.isMigrated) {
      return;
    }

    // Update owner and migration status
    context.subgraph_domain.set({
      ...domain,
      owner_id: owner,
      isMigrated,
    });
  } else {
    // Domain does not yet exist -- create it

    // Look up the parent domain to construct the name
    const parent = await context.subgraph_domain.get(parentNode);

    // Construct the name from the parent's name + the encoded label
    const label = encodeLabelHash(labelHash);
    const name = parent?.name ? `${label}.${parent.name}` : label;

    context.subgraph_domain.set({
      id: node,
      name,
      labelName: undefined,
      labelhash: labelHash,
      parent_id: parentNode,
      subdomainCount: 0,
      resolvedAddress_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      isMigrated,
      createdAt: BigInt(event.block.timestamp),
      owner_id: owner,
      registrant_id: undefined,
      wrappedOwner_id: undefined,
      expiryDate: undefined,
    });

    // Increment parent's subdomain count
    if (parent) {
      context.subgraph_domain.set({
        ...parent,
        subdomainCount: parent.subdomainCount + 1,
      });
    }
  }

  // Garbage collect: if the new owner is the zero address, the domain is
  // being effectively deleted. Recursively decrement parent subdomain counts
  // for any newly empty domains.
  if (owner === ZERO_ADDRESS) {
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  }

  // Log the NewOwner event entity
  context.subgraph_new_owner.set({
    ...sharedEventValues(event.chainId, event),
    parentDomain_id: parentNode,
    domain_id: node,
    owner_id: owner,
  });

  // PA: track migration from RegistryOld → Registry (ENS Root only)
  if (isMigrated && event.chainId === 1) {
    migrateNode(context, node);
  }
}

// ─── RegistryOld.NewOwner ───────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RegistryOld", event: "NewOwner" },
  async ({ event, context }) => {
    await handleNewOwner(event, context, false);
  },
);

// ─── Registry.NewOwner ──────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "Registry", event: "NewOwner" },
  async ({ event, context }) => {
    await handleNewOwner(event, context, true);
  },
);

// ─── Shared Transfer Handler ────────────────────────────────────────────────

async function handleTransfer(
  event: {
    params: { node: string; owner: string };
    block: { number: number; timestamp: number };
    logIndex: number;
    transaction: { hash: string };
    srcAddress: string;
  },
  context: handlerContext,
): Promise<void> {
  const { node, owner } = event.params;

  // Upsert account for the new owner
  upsertAccount(context, owner);

  // Ensure domain exists and update owner
  const domain = await context.subgraph_domain.get(node);
  if (domain) {
    context.subgraph_domain.set({
      ...domain,
      owner_id: owner,
    });
  } else {
    // Domain not yet seen -- create a minimal record
    context.subgraph_domain.set({
      id: node,
      name: undefined,
      labelName: undefined,
      labelhash: undefined,
      parent_id: undefined,
      subdomainCount: 0,
      resolvedAddress_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      isMigrated: false,
      createdAt: BigInt(event.block.timestamp),
      owner_id: owner,
      registrant_id: undefined,
      wrappedOwner_id: undefined,
      expiryDate: undefined,
    });
  }

  // Garbage collect if owner is zero address
  if (owner === ZERO_ADDRESS) {
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  }

  // Log the Transfer event entity
  context.subgraph_transfer.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    owner_id: owner,
  });
}

// ─── RegistryOld.Transfer ───────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RegistryOld", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context);
  },
);

// ─── Registry.Transfer ──────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "Registry", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context);
  },
);

// ─── Shared NewResolver Handler ─────────────────────────────────────────────

async function handleNewResolver(
  event: {
    params: { node: string; resolver: string };
    block: { number: number; timestamp: number };
    logIndex: number;
    transaction: { hash: string };
    srcAddress: string;
  },
  context: handlerContext,
  isOldRegistry: boolean = false,
): Promise<void> {
  const { node, resolver: resolverAddress } = event.params;
  const isZeroResolver = resolverAddress === ZERO_ADDRESS;

  const resolverId = makeResolverId(event.chainId, resolverAddress, node);

  // Load the domain (it should exist from a prior NewOwner event)
  const domain = await context.subgraph_domain.get(node);

  if (isZeroResolver) {
    // Clear the domain's resolver and resolved address references
    if (domain) {
      context.subgraph_domain.set({
        ...domain,
        resolver_id: undefined,
        resolvedAddress_id: undefined,
      });
    }

    // Garbage collect newly empty domain if necessary
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  } else {
    // Upsert the resolver record
    const resolver = await upsertResolver(context, {
      id: resolverId,
      domain_id: node,
      address: resolverAddress,
    });

    // Update domain to point to the new resolver
    if (domain) {
      context.subgraph_domain.set({
        ...domain,
        resolver_id: resolverId,
        resolvedAddress_id: resolver.addr_id,
      });
    }
  }

  // Log the NewResolver entity
  // NOTE: for subgraph compatibility, when the resolver is the zero address
  // we still log a resolver_id pointing to the zero address string, matching
  // the original subgraph behavior (even though no Resolver entity exists for it).
  context.subgraph_new_resolver.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    resolver_id: isZeroResolver ? ZERO_ADDRESS : resolverId,
  });

  // PA: track domain-resolver relationship
  // For RegistryOld on ENS Root: skip PA update if node is migrated
  if (isOldRegistry && event.chainId === 1) {
    const migrated = await nodeIsMigrated(context, node);
    if (migrated) return;
  }

  upsertDomainResolverRelation(
    context,
    event.chainId,
    event.srcAddress,
    node,
    resolverAddress,
  );
}

// ─── RegistryOld.NewResolver ────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RegistryOld", event: "NewResolver" },
  async ({ event, context }) => {
    await handleNewResolver(event, context, true);
  },
);

// ─── Registry.NewResolver ───────────────────────────────────────────────────

indexer.onEvent(
  { contract: "Registry", event: "NewResolver" },
  async ({ event, context }) => {
    await handleNewResolver(event, context, false);
  },
);

// ─── Shared NewTTL Handler ──────────────────────────────────────────────────

async function handleNewTTL(
  event: {
    params: { node: string; ttl: bigint };
    block: { number: number; timestamp: number };
    logIndex: number;
    transaction: { hash: string };
    srcAddress: string;
  },
  context: handlerContext,
): Promise<void> {
  const { node, ttl } = event.params;

  // Update the domain's TTL
  const domain = await context.subgraph_domain.get(node);
  if (domain) {
    context.subgraph_domain.set({
      ...domain,
      ttl,
    });
  }

  // Log the NewTTL event entity
  context.subgraph_new_ttl.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    ttl,
  });
}

// ─── RegistryOld.NewTTL ────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RegistryOld", event: "NewTTL" },
  async ({ event, context }) => {
    await handleNewTTL(event, context);
  },
);

// ─── Registry.NewTTL ───────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "Registry", event: "NewTTL" },
  async ({ event, context }) => {
    await handleNewTTL(event, context);
  },
);
