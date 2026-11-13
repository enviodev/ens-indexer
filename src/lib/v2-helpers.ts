import { keccak256, concat } from "viem";
import { syncLegacyProjection } from "./legacy-projection";
import type { Entity } from "envio";
import {
  ETH_NODE,
  ROOT_NODE,
  ZERO_ADDRESS,
  encodeLabelHash,
  isInterpretableLabel,
  type handlerContext,
} from "./helpers";
import { seedKind } from "./v2-deployments";

export type V2Registry = Entity<"V2_registry">;
export type V2Domain = Entity<"V2_domain">;
export type V2Edge = Entity<"V2_registry_edge">;

// Guards the walk down the registry tree. Registries can link in cycles.
export const MAX_REGISTRY_DEPTH = 64;

const VERSION_MASK = 0xffffffffn;

/** A tokenId with its version bits cleared (LibLabel.withVersion(id, 0)). */
export function storageIdOf(id: bigint): bigint {
  return id & ~VERSION_MASK;
}

export function toHex32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function makeV2RegistryId(chainId: number, address: string): string {
  return `${chainId}-${address.toLowerCase()}`;
}

export function makeV2DomainId(chainId: number, registry: string, tokenId: bigint): string {
  return `${makeV2RegistryId(chainId, registry)}-${toHex32(storageIdOf(tokenId))}`;
}

export function makeV2EventId(chainId: number, block: number, logIndex: number): string {
  return `${chainId}-${block}-${logIndex}`;
}

export function childNode(parentNode: string, labelhash: string): string {
  return keccak256(concat([parentNode as `0x${string}`, labelhash as `0x${string}`]));
}

/** The label as it appears in a name. Uninterpretable labels stay encoded. */
export function displayLabel(label: string | undefined, labelhash: string): string {
  return label !== undefined && isInterpretableLabel(label) ? label : encodeLabelHash(labelhash);
}

export function joinName(label: string, parentName: string): string {
  return parentName === "" ? label : `${label}.${parentName}`;
}

export function nullableAddress(address: string): string | undefined {
  const a = address.toLowerCase();
  return a === ZERO_ADDRESS ? undefined : a;
}

/**
 * Get or create a registry row. Seeds are proven from their first appearance;
 * every other registry starts unproven and waits for a link.
 */
export async function ensureV2Registry(
  context: handlerContext,
  chainId: number,
  address: string,
  created?: { block: number; timestamp: number },
): Promise<V2Registry> {
  const id = makeV2RegistryId(chainId, address);
  const existing = await context.V2_registry.get(id);
  if (existing) {
    if (created && existing.createdBlock === undefined) {
      const updated = {
        ...existing,
        createdBlock: created.block,
        createdTimestamp: BigInt(created.timestamp),
      };
      context.V2_registry.set(updated);
      return updated;
    }
    return existing;
  }
  const kind = seedKind(chainId, address);
  const seed =
    kind === "root"
      ? { proven: true, node: ROOT_NODE, name: "" }
      : kind === "eth"
        ? { proven: true, node: ETH_NODE, name: "eth" }
        : { proven: false, node: undefined, name: undefined };
  const row: V2Registry = {
    id,
    address: address.toLowerCase(),
    kind: kind ?? "user",
    proven: seed.proven,
    node: seed.node,
    name: seed.name,
    parentDomain_id: undefined,
    claimedParent: undefined,
    claimedLabel: undefined,
    claimMatchesLink: undefined,
    createdBlock: created?.block,
    createdTimestamp: created ? BigInt(created.timestamp) : undefined,
  };
  context.V2_registry.set(row);
  return row;
}

/** Name and node a domain has in its registry. Undefined until the registry is proven. */
export function nameInRegistry(
  registry: V2Registry,
  label: string | undefined,
  labelhash: string,
): { name: string | undefined; node: string | undefined } {
  if (!registry.proven || registry.node === undefined || registry.name === undefined) {
    return { name: undefined, node: undefined };
  }
  return {
    name: joinName(displayLabel(label, labelhash), registry.name),
    node: childNode(registry.node, labelhash),
  };
}

/** Ensure the resolver row exists; mark it proven when a proven registry links to it. */
export async function ensureV2Resolver(
  context: handlerContext,
  chainId: number,
  address: string,
  opts: { discoveredVia: string; createdBlock?: number; linkedBlock?: number; proven?: boolean },
): Promise<void> {
  const id = makeV2RegistryId(chainId, address);
  const existing = await context.V2_resolver.get(id);
  if (existing) {
    const proven = existing.proven || opts.proven === true;
    const firstLinkedBlock = existing.firstLinkedBlock ?? opts.linkedBlock;
    const createdBlock = existing.createdBlock ?? opts.createdBlock;
    if (
      proven !== existing.proven ||
      firstLinkedBlock !== existing.firstLinkedBlock ||
      createdBlock !== existing.createdBlock
    ) {
      context.V2_resolver.set({ ...existing, proven, firstLinkedBlock, createdBlock });
    }
    return;
  }
  context.V2_resolver.set({
    id,
    address: address.toLowerCase(),
    proven: opts.proven === true,
    discoveredVia: opts.discoveredVia,
    createdBlock: opts.createdBlock,
    firstLinkedBlock: opts.linkedBlock,
  });
}

/**
 * Pick the link that names a registry. The registry's own ParentUpdated claim
 * breaks ties, but only among links that really exist: a claim alone proves
 * nothing. Otherwise the newest proven link wins.
 */
export function pickCanonicalEdge(
  registry: V2Registry,
  candidates: readonly { edge: V2Edge; parentRegistry: V2Registry; parentDomain: V2Domain }[],
): { edge: V2Edge; parentRegistry: V2Registry; parentDomain: V2Domain } | undefined {
  const proven = candidates.filter(
    (c) => c.parentRegistry.proven && c.parentDomain.status !== "UNREGISTERED",
  );
  if (proven.length === 0) return undefined;
  const claimed = proven.find(
    (c) =>
      registry.claimedParent !== undefined &&
      c.parentRegistry.address === registry.claimedParent &&
      registry.claimedLabel !== undefined &&
      c.parentDomain.label === registry.claimedLabel,
  );
  if (claimed) return claimed;
  return [...proven].sort(
    (a, b) => b.edge.linkedBlock - a.edge.linkedBlock || (a.edge.id < b.edge.id ? -1 : 1),
  )[0];
}

/**
 * Recompute a registry's proven status and name from its live links, then push
 * the result down to its domains and child registries.
 *
 * This is what makes names independent of event order: a label can be written
 * before its registry is linked, and it gets its name when the link arrives.
 */
export async function propagateV2Registry(
  context: handlerContext,
  chainId: number,
  registryAddress: string,
  depth = 0,
  seen: Set<string> = new Set(),
  at?: { block: { number: number; timestamp: number } },
): Promise<void> {
  if (depth > MAX_REGISTRY_DEPTH) {
    context.log.warn(`registry tree deeper than ${MAX_REGISTRY_DEPTH} at ${registryAddress}`);
    return;
  }
  const id = makeV2RegistryId(chainId, registryAddress);
  if (seen.has(id)) return;
  seen.add(id);

  const registry = await context.V2_registry.get(id);
  if (!registry) return;

  let next: Pick<V2Registry, "proven" | "node" | "name" | "parentDomain_id" | "claimMatchesLink">;
  if (seedKind(chainId, registry.address)) {
    next = {
      proven: true,
      node: registry.node,
      name: registry.name,
      parentDomain_id: registry.parentDomain_id,
      claimMatchesLink: registry.claimMatchesLink,
    };
  } else {
    const edges = await context.V2_registry_edge.getWhere({ childRegistry_id: { _eq: id } });
    const candidates = [];
    for (const edge of edges) {
      if (!edge.active) continue;
      const parentDomain = await context.V2_domain.get(edge.parentDomain_id);
      if (!parentDomain) continue;
      const parentRegistry = await context.V2_registry.get(parentDomain.registry_id);
      if (!parentRegistry) continue;
      candidates.push({ edge, parentRegistry, parentDomain });
    }
    const chosen = pickCanonicalEdge(registry, candidates);
    const claimMatchesLink =
      registry.claimedParent === undefined
        ? undefined
        : candidates.some(
            (c) =>
              c.parentRegistry.address === registry.claimedParent &&
              c.parentDomain.label === registry.claimedLabel,
          );
    if (chosen && chosen.parentDomain.node !== undefined && chosen.parentDomain.name !== undefined) {
      next = {
        proven: true,
        node: chosen.parentDomain.node,
        name: chosen.parentDomain.name,
        parentDomain_id: chosen.parentDomain.id,
        claimMatchesLink,
      };
    } else {
      next = {
        proven: false,
        node: undefined,
        name: undefined,
        parentDomain_id: undefined,
        claimMatchesLink,
      };
    }
  }

  const nameChanged =
    next.proven !== registry.proven || next.node !== registry.node || next.name !== registry.name;
  const updated: V2Registry = { ...registry, ...next };
  if (
    nameChanged ||
    next.parentDomain_id !== registry.parentDomain_id ||
    next.claimMatchesLink !== registry.claimMatchesLink
  ) {
    context.V2_registry.set(updated);
  }
  if (!nameChanged) return;

  const domains = await context.V2_domain.getWhere({ registry_id: { _eq: id } });
  for (const domain of domains) {
    const { name, node } = nameInRegistry(updated, domain.label, domain.labelhash);
    if (name !== domain.name || node !== domain.node) {
      const row = { ...domain, name, node };
      context.V2_domain.set(row);
      if (at) await syncLegacyProjection(context, chainId, row, at);
    }
    if (updated.proven && domain.resolver) {
      await ensureV2Resolver(context, chainId, domain.resolver, {
        discoveredVia: "ResolverUpdated",
        proven: true,
      });
    }
    if (domain.subregistry) {
      await propagateV2Registry(context, chainId, domain.subregistry, depth + 1, seen, at);
    }
  }
}

/** Upsert the link from a domain to a child registry and re-derive the child. */
export async function setV2Edge(
  context: handlerContext,
  chainId: number,
  parentDomainId: string,
  childAddress: string,
  active: boolean,
  meta: { block: number; timestamp: number; sender?: string },
): Promise<void> {
  const childRegistryId = makeV2RegistryId(chainId, childAddress);
  const id = `${parentDomainId}-${childRegistryId}`;
  const existing = await context.V2_registry_edge.get(id);
  if (existing) {
    context.V2_registry_edge.set({
      ...existing,
      active,
      linkedBlock: active ? meta.block : existing.linkedBlock,
      linkedTimestamp: active ? BigInt(meta.timestamp) : existing.linkedTimestamp,
      unlinkedBlock: active ? undefined : meta.block,
      sender: meta.sender ?? existing.sender,
    });
  } else if (active) {
    context.V2_registry_edge.set({
      id,
      parentDomain_id: parentDomainId,
      childRegistry_id: childRegistryId,
      active: true,
      linkedBlock: meta.block,
      linkedTimestamp: BigInt(meta.timestamp),
      unlinkedBlock: undefined,
      sender: meta.sender,
    });
  }
  await propagateV2Registry(context, chainId, childAddress, 0, new Set(), { block: { number: meta.block, timestamp: meta.timestamp } });
}

export { ROOT_NODE };
