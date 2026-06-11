import { indexer } from "envio";
import type { handlerContext } from "../lib/helpers";

import {
  makeSubdomainNode,
  ROOT_NODE,
  ZERO_ADDRESS,
  ADDR_REVERSE_NODE,
  upsertAccount,
  makeResolverId,
  upsertResolver,
  sharedEventValues,
  recursivelyRemoveEmptyDomainFromParentSubdomainCount,
  ensureRootDomain,
} from "../lib/helpers";

import {
  IS_SUBGRAPH_COMPAT,
  isLabelSubgraphIndexable,
  healLabelByLabelHash,
  interpretHealedLabel,
  constructSubInterpretedName,
  maybeHealLabelByAddrReverseSubname,
} from "../lib/interpretation";

import {
  upsertDomainResolverRelation,
  migrateNode,
  nodeIsMigrated,
} from "../lib/protocol-acceleration";

// ─── RegistryOld Event Gating ───────────────────────────────────────────────
// Due to a security issue, ENS migrated from the old registry to the new one.
// Like the reference ENSIndexer, we ignore RegistryOld events for any domain
// that has already been migrated to the (new) Registry — for ALL event types
// (NewOwner, Transfer, NewResolver, NewTTL), with a root-node exception for
// NewResolver. This gating must run before any entity writes (incl. account
// upserts) so the produced data matches the reference byte-for-byte.

async function shouldIgnoreRegistryOldEvents(
  context: handlerContext,
  node: string,
): Promise<boolean> {
  const domain = await context.subgraph_domains.get(node);
  return domain?.is_migrated ?? false;
}

// NOTE: Resolver events are indexed in wildcard mode (all addresses), matching
// the reference ENSIndexer whose Resolver datasource has no address filter —
// it captures resolver-signature events from ANY contract since the registry
// deploy block, including events emitted before (or without) any NewResolver
// registration. Dynamic contractRegister-based registration was removed
// because it only captures events from the registration block forward, which
// produced missing rows vs the reference.

// ─── Shared NewOwner Handler ────────────────────────────────────────────────

async function handleNewOwner(
  event: {
    params: { node: string; label: string; owner: string };
    block: { number: number; timestamp: number };
    chainId: number;
    logIndex: number;
    transaction: { hash: string; from?: string | undefined };
    srcAddress: string;
  },
  context: handlerContext,
  is_migrated: boolean,
): Promise<void> {
  const { label: labelHash, node: parentNode, owner } = event.params;

  // Compute the subdomain node from labelHash + parentNode
  const node = makeSubdomainNode(labelHash, parentNode);

  // Ensure the root domain exists (idempotent; reference creates it in the
  // contract `setup` event before any other writes)
  await ensureRootDomain(context);

  // Upsert account for the new owner
  upsertAccount(context, owner);

  // Load existing domain
  let domain = await context.subgraph_domains.get(node);

  if (domain) {
    // Update owner and migration status
    domain = {
      ...domain,
      owner_id: owner,
      is_migrated,
    };
    context.subgraph_domains.set(domain);
  } else {
    // Domain does not yet exist -- create it (name is constructed below)
    domain = {
      id: node,
      name: undefined,
      label_name: undefined,
      labelhash: labelHash,
      parent_id: parentNode,
      subdomain_count: 0,
      resolved_address_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      is_migrated,
      created_at: BigInt(event.block.timestamp),
      owner_id: owner,
      registrant_id: undefined,
      wrapped_owner_id: undefined,
      expiry_date: undefined,
    };
    context.subgraph_domains.set(domain);

    // Increment parent's subdomain count
    const parent = await context.subgraph_domains.get(parentNode);
    if (parent) {
      context.subgraph_domains.set({
        ...parent,
        subdomain_count: parent.subdomain_count + 1,
      });
    }
  }

  // If the domain doesn't yet have a name, attempt to construct it here —
  // healing the label first, exactly like the reference ENSIndexer
  // (SUBGRAPH_COMPAT=false semantics).
  if (domain.name === undefined) {
    const parent = await context.subgraph_domains.get(parentNode);

    let healedLabel: string | null = null;

    // For subnames of addr.reverse on the ENS Root chain, the label is the
    // lowercase hex of an address involved in the transaction.
    // NOTE(subgraph-compat): reverse-address healing is disabled — the legacy
    // subgraph only heals via the rainbow tables.
    if (!IS_SUBGRAPH_COMPAT && parentNode === ADDR_REVERSE_NODE && event.chainId === 1) {
      healedLabel =
        (event.transaction.from !== undefined
          ? maybeHealLabelByAddrReverseSubname(labelHash, event.transaction.from)
          : null) ?? maybeHealLabelByAddrReverseSubname(labelHash, owner);

      // The reference falls back to the deployed contract address (via
      // transaction receipt) and finally all addresses in the transaction
      // trace (debug_traceTransaction). Those paths require extra RPC calls;
      // fail loudly if we ever need them so the divergence is visible.
      if (healedLabel === null) {
        throw new Error(
          `Unable to heal addr.reverse subname label for labelHash '${labelHash}' ` +
            `(tx ${event.transaction.hash}). Receipt/trace healing fallback not yet implemented.`,
        );
      }
    }

    // If reverse-address healing didn't apply, heal via ENSRainbow
    if (healedLabel === null) {
      healedLabel = await context.effect(healLabelByLabelHash, labelHash);
    }

    if (IS_SUBGRAPH_COMPAT) {
      // Subgraph Interpreted: the healed Literal Label as-is if it's
      // subgraph-indexable, otherwise the Encoded LabelHash; labelName is
      // only set for subgraph-indexable healed labels (else stays null).
      const subgraphInterpretedLabel = isLabelSubgraphIndexable(healedLabel)
        ? healedLabel
        : `[${labelHash.slice(2)}]`;
      const name = constructSubInterpretedName(subgraphInterpretedLabel, parent?.name);

      domain = {
        ...domain,
        name,
        label_name: isLabelSubgraphIndexable(healedLabel) ? healedLabel : undefined,
      };
      context.subgraph_domains.set(domain);
    } else {
      // Interpreted Label: healed label if normalized (else its encoded
      // literal labelhash), or the Encoded LabelHash when healing failed
      const interpretedLabel = interpretHealedLabel(labelHash, healedLabel);

      // A name constructed of Interpreted Labels is Interpreted. The root's
      // name is '' so a TLD's name is just its label.
      const name = constructSubInterpretedName(interpretedLabel, parent?.name);

      domain = { ...domain, name, label_name: interpretedLabel };
      context.subgraph_domains.set(domain);
    }
  }

  // Garbage collect: if the new owner is the zero address, the domain is
  // being effectively deleted. Recursively decrement parent subdomain counts
  // for any newly empty domains.
  if (owner === ZERO_ADDRESS) {
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  }

  // Log the NewOwner event entity
  context.subgraph_new_owners.set({
    ...sharedEventValues(event.chainId, event),
    parent_domain_id: parentNode,
    domain_id: node,
    owner_id: owner,
  });

  // PA: track migration from RegistryOld → Registry (ENS Root only)
  if (is_migrated && event.chainId === 1) {
    migrateNode(context, node);
  }
}

// ─── RegistryOld.NewOwner ───────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RegistryOld", event: "NewOwner" },
  async ({ event, context }) => {
    // The reference creates the root domain in ponder's `setup` event before
    // any log is processed — replicate that before the migration gating so
    // the root's is_migrated=true is visible to the very first events.
    await ensureRootDomain(context);

    const node = makeSubdomainNode(event.params.label, event.params.node);
    if (await shouldIgnoreRegistryOldEvents(context, node)) return;

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
    chainId: number;
    logIndex: number;
    transaction: { hash: string };
    srcAddress: string;
  },
  context: handlerContext,
): Promise<void> {
  const { node, owner } = event.params;

  await ensureRootDomain(context);

  // Upsert account for the new owner
  upsertAccount(context, owner);

  // Ensure domain exists and update owner
  const domain = await context.subgraph_domains.get(node);
  if (domain) {
    context.subgraph_domains.set({
      ...domain,
      owner_id: owner,
    });
  } else {
    // Domain not yet seen -- create a minimal record
    context.subgraph_domains.set({
      id: node,
      name: undefined,
      label_name: undefined,
      labelhash: undefined,
      parent_id: undefined,
      subdomain_count: 0,
      resolved_address_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      is_migrated: false,
      created_at: BigInt(event.block.timestamp),
      owner_id: owner,
      registrant_id: undefined,
      wrapped_owner_id: undefined,
      expiry_date: undefined,
    });
  }

  // Garbage collect if owner is zero address
  if (owner === ZERO_ADDRESS) {
    await recursivelyRemoveEmptyDomainFromParentSubdomainCount(context, node);
  }

  // Log the Transfer event entity
  context.subgraph_transfers.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    owner_id: owner,
  });
}

// ─── RegistryOld.Transfer ───────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RegistryOld", event: "Transfer" },
  async ({ event, context }) => {
    // NOTE: like the reference (and the subgraph before it), this implicitly
    // ignores Transfer events of the root node, whose is_migrated is true
    // from creation — the root's owner remains zeroAddress until the new
    // Registry events are picked up.
    await ensureRootDomain(context);
    if (await shouldIgnoreRegistryOldEvents(context, event.params.node)) return;

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
    chainId: number;
    logIndex: number;
    transaction: { hash: string };
    srcAddress: string;
  },
  context: handlerContext,
  isOldRegistry: boolean = false,
): Promise<void> {
  const { node, resolver: resolverAddress } = event.params;
  const isZeroResolver = resolverAddress === ZERO_ADDRESS;

  await ensureRootDomain(context);

  const resolverId = makeResolverId(event.chainId, resolverAddress, node);

  // Load the domain (it should exist from a prior NewOwner event)
  const domain = await context.subgraph_domains.get(node);

  if (isZeroResolver) {
    // Clear the domain's resolver and resolved address references
    if (domain) {
      context.subgraph_domains.set({
        ...domain,
        resolver_id: undefined,
        resolved_address_id: undefined,
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
      context.subgraph_domains.set({
        ...domain,
        resolver_id: resolverId,
        resolved_address_id: resolver.addr_id,
      });
    }
  }

  // Log the NewResolver entity
  // NOTE: for subgraph compatibility, when the resolver is the zero address
  // we still log a resolver_id pointing to the zero address string, matching
  // the original subgraph behavior (even though no Resolver entity exists for it).
  context.subgraph_new_resolvers.set({
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
    await ensureRootDomain(context);

    const shouldIgnoreEvent = await shouldIgnoreRegistryOldEvents(
      context,
      event.params.node,
    );
    const isRootNode = event.params.node === ROOT_NODE;

    // NOTE: exception for the root node — it starts out is_migrated: true,
    // but we definitely still want to handle NewResolver events for it.
    if (shouldIgnoreEvent && !isRootNode) return;

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
    chainId: number;
    logIndex: number;
    transaction: { hash: string };
    srcAddress: string;
  },
  context: handlerContext,
): Promise<void> {
  const { node, ttl } = event.params;

  // Update the domain's TTL
  const domain = await context.subgraph_domains.get(node);
  if (domain) {
    context.subgraph_domains.set({
      ...domain,
      ttl,
    });
  }

  // Log the NewTTL event entity
  context.subgraph_new_ttls.set({
    ...sharedEventValues(event.chainId, event),
    domain_id: node,
    ttl,
  });
}

// ─── RegistryOld.NewTTL ────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RegistryOld", event: "NewTTL" },
  async ({ event, context }) => {
    await ensureRootDomain(context);
    if (await shouldIgnoreRegistryOldEvents(context, event.params.node)) return;

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
