// ENSv2 projection into the legacy (subgraph-shaped) tables, as the ENS subgraph does
// it (ensdomains/ens-subgraph 16846b1: src/ensv2Domain.ts projectPathToDomain,
// syncProjectedHolder, syncProjectedExpiry, retireProjectedDomain; src/legacyGovernance.ts).
//
// A REGISTERED v2 name on a proven path (any registry but the root registry, whose
// paths eth and reverse collide with the v1 root-label rows) owns its subgraph_domain
// row: owner and registrant are the v2 holder, expiry is the v2 expiry (plus the v2
// grace period for the .eth registry, clamped), the resolver is the v2 resolver, the
// ENSv1 wrapper state is dropped, and the canonical <label>.eth path also owns its
// subgraph_registration. While that holds, v1 Registry, BaseRegistrar and NameWrapper
// events for the node only write their event rows (isGovernedByV2). Unregistering the
// name retires the row with the ENSv1 deletion convention. v1 resolver record events
// are unaffected.
import type { handlerContext } from "./helpers";
import {
  ETH_NODE,
  ZERO_ADDRESS,
  clampLegacyExpiry,
  indexableOrUndefined,
  isInterpretableLabel,
  namespaceForNewDomain,
  setDomain,
  setRegistration,
} from "./helpers";
import type { V2Domain } from "./v2-helpers";
import { V2_DEPLOYMENTS } from "./v2-deployments";

// ETHRegistrar GRACE_PERIOD_V2 on mainnet and Sepolia: 28 days (src/ensv2Constants.ts
// getV2GracePeriod; contracts-v2 script/deploy-constants.ts).
export const V2_GRACE_PERIOD = 2_419_200n;

const markerId = (chainId: number, node: string) => `${chainId}-${node}`;

/** Whether the ENSv2 projection owns this node's legacy row (src/legacyGovernance.ts). */
export async function isGovernedByV2(context: handlerContext, chainId: number, node: string): Promise<boolean> {
  if (!V2_DEPLOYMENTS[chainId]) return false;
  return (await context.Legacy_projection.get(markerId(chainId, node)))?.active === true;
}

/**
 * Bring the legacy row for a v2 name in line with the v2 state. Call after every
 * write of a v2_domain row.
 */
export async function syncLegacyProjection(
  context: handlerContext,
  chainId: number,
  domain: V2Domain,
  event: { block: { number: number; timestamp: number } },
): Promise<void> {
  if (!domain.node) return; // not on a proven path
  const registry = await context.V2_registry.get(domain.registry_id);
  if (!registry?.proven || registry.kind === "root" || !registry.node) return;
  const node = domain.node;
  const id = markerId(chainId, node);
  const marker = await context.Legacy_projection.get(id);

  if (domain.status === "REGISTERED" && domain.owner) {
    await project(context, chainId, domain, registry.kind === "eth", registry.node, marker?.active === true, event);
    context.Legacy_projection.set({ id, node, v2Domain: domain.id, active: true, updatedBlock: event.block.number });
  } else if (marker?.active && domain.status === "UNREGISTERED") {
    await retire(context, node, registry.kind === "eth" && registry.node === ETH_NODE, event);
    context.Legacy_projection.set({ ...marker, active: false, updatedBlock: event.block.number });
  }
}

async function project(
  context: handlerContext,
  chainId: number,
  domain: V2Domain,
  isEth: boolean,
  parentNode: string,
  alreadyProjected: boolean,
  event: { block: { number: number; timestamp: number } },
): Promise<void> {
  const node = domain.node!;
  const owner = domain.owner!;
  const label = domain.label !== undefined && isInterpretableLabel(domain.label) ? indexableOrUndefined(domain.label) : undefined;
  const expiryDate = domain.expiry === undefined ? undefined : clampLegacyExpiry(isEth ? domain.expiry + V2_GRACE_PERIOD : domain.expiry);
  const resolverId = domain.resolver ? `${chainId}-${domain.resolver}-${node}` : undefined;
  const resolvedAddress = resolverId ? (await context.Subgraph_resolver.get(resolverId))?.addr_id : undefined;

  const legacy = await context.Subgraph_domain.get(node);
  // A registration retires the ENSv1 NameWrapper state (projectPathToDomain).
  if (!alreadyProjected && legacy?.wrappedOwner_id) context.Subgraph_wrapped_domain.deleteUnsafe(node);
  // A new row, or an existing row in the ENSv1 deleted state (owner 0x0, no resolver,
  // no children), counts as a new child of its parent (projectPathToDomain
  // countsAsNewChild). The parent is linked only if its row exists
  // (linkProjectedDomainToParent).
  const countsAsNewChild = !legacy || (!alreadyProjected && legacy.owner_id === ZERO_ADDRESS && !legacy.resolver_id && legacy.subdomainCount === 0);
  const parent = await context.Subgraph_domain.get(parentNode);
  if (parent && countsAsNewChild) setDomain(context, { ...parent, subdomainCount: parent.subdomainCount + 1 });
  setDomain(context, {
    ...(legacy ?? {
      id: node,
      subdomainCount: 0,
      ttl: undefined,
      createdAt: BigInt(event.block.timestamp),
      namespace: namespaceForNewDomain(node, parentNode, undefined),
    }),
    name: domain.name ?? legacy?.name,
    labelName: label ?? legacy?.labelName,
    labelhash: domain.labelhash,
    parent_id: parent ? parentNode : legacy?.parent_id,
    owner_id: owner,
    registrant_id: owner,
    wrappedOwner_id: undefined,
    isMigrated: true,
    expiryDate,
    registrationExpiryDate: isEth ? clampLegacyExpiry(domain.expiry) : legacy?.registrationExpiryDate,
    resolver_id: resolverId,
    resolvedAddress_id: resolvedAddress,
  });

  // The canonical <label>.eth path owns the legacy registration (syncEthRegistration).
  if (isEth && parentNode === ETH_NODE && domain.expiry !== undefined) {
    const existing = await context.Subgraph_registration.get(node);
    // A migration continues the ENSv1 registration and keeps its date.
    const registrationDate = existing && domain.isMigrated
      ? existing.registrationDate
      : domain.registeredTimestamp ?? BigInt(event.block.timestamp);
    setRegistration(context, {
      ...(existing ?? { id: node, domain_id: node, cost: undefined }),
      registrationDate,
      expiryDate: domain.expiry,
      registrant_id: owner,
      labelName: label ?? existing?.labelName,
    });
  }
}

async function retire(
  context: handlerContext,
  node: string,
  canonicalEth: boolean,
  event: { block: { number: number; timestamp: number } },
): Promise<void> {
  const legacy = await context.Subgraph_domain.get(node);
  if (!legacy) return;
  // The retired row leaves its parent's subdomainCount (adjustParentSubdomainCount).
  if (legacy.parent_id) {
    const parent = await context.Subgraph_domain.get(legacy.parent_id);
    if (parent && parent.subdomainCount > 0) setDomain(context, { ...parent, subdomainCount: parent.subdomainCount - 1 });
  }
  const now = BigInt(event.block.timestamp);
  setDomain(context, {
    ...legacy,
    owner_id: ZERO_ADDRESS,
    registrant_id: undefined,
    wrappedOwner_id: undefined,
    resolver_id: undefined,
    resolvedAddress_id: undefined,
    expiryDate: now,
  });
  context.Subgraph_wrapped_domain.deleteUnsafe(node);
  if (canonicalEth) {
    const registration = await context.Subgraph_registration.get(node);
    if (registration) setRegistration(context, { ...registration, expiryDate: now });
  }
}
