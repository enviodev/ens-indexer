import { keccak256, encodePacked, zeroAddress } from "viem";
import type { EvmOnEventContext, Entity } from "envio";

import {
  IS_SUBGRAPH_COMPAT,
  isLabelSubgraphIndexable,
  literalLabelToInterpretedLabel,
} from "./interpretation";

export type handlerContext = EvmOnEventContext;
export type Domain = Entity<"subgraph_domains">;

// ─── Constants ──────────────────────────────────────────────────────────────

export const ROOT_NODE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export const ETH_NODE =
  "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae";

export const ADDR_REVERSE_NODE =
  "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2";

export const ZERO_ADDRESS = zeroAddress;

export const GRACE_PERIOD_SECONDS = 7776000n; // 90 days in seconds

// BASE_ETH_NODE = namehash("base.eth") = keccak256(ETH_NODE + keccak256("base"))
export const BASE_ETH_NODE =
  "0xff1e3c0eb00ec714e34b6114125fbde1dea2f24a72fbf672e7b7fd5690328e10";

// LINEA_ETH_NODE = namehash("linea.eth") = keccak256(ETH_NODE + keccak256("linea"))
export const LINEA_ETH_NODE =
  "0x527aac89ac1d1de5dd84cff89ec92c69b028ce9ce3fa3d654882474ab4402ec3";

// Set of all managed registrar nodes (for NameWrapper expiry_date preservation)
export const MANAGED_NODES = new Set([ETH_NODE, BASE_ETH_NODE, LINEA_ETH_NODE]);

// ThreeDNS hardcoded protocol-wide resolver (same on Optimism + Base)
export const THREEDNS_RESOLVER = "0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8";

// ─── Token / Label Helpers ──────────────────────────────────────────────────

/**
 * Convert a BaseRegistrar tokenId (bigint) to a labelHash hex string.
 * The tokenId IS the labelHash as a uint256.
 */
export function tokenIdToLabelHash(tokenId: bigint): string {
  return "0x" + tokenId.toString(16).padStart(64, "0");
}

// ─── Node Computation ───────────────────────────────────────────────────────

export function makeSubdomainNode(
  labelHash: string,
  parentNode: string,
): string {
  return keccak256(encodePacked(["bytes32", "bytes32"], [parentNode as `0x${string}`, labelHash as `0x${string}`]));
}

// ─── ID Generation ──────────────────────────────────────────────────────────

// ID formats mirror the reference ENSIndexer (src/lib/subgraph/ids.ts):
// chain-scoped by default; legacy subgraph formats in SUBGRAPH_COMPAT mode.

export function makeResolverId(
  chainId: number,
  resolverAddress: string,
  node: string,
): string {
  if (IS_SUBGRAPH_COMPAT) return `${resolverAddress}-${node}`;
  return `${chainId}-${resolverAddress}-${node}`;
}

export function makeEventId(
  chainId: number,
  block_number: number,
  logIndex: number,
  transferIndex?: number,
): string {
  const parts: (number | undefined)[] = IS_SUBGRAPH_COMPAT
    ? [block_number, logIndex, transferIndex]
    : [chainId, block_number, logIndex, transferIndex];
  return parts.filter((p) => p !== undefined).join("-");
}

export function makeRegistrationId(labelHash: string, node: string): string {
  // Subgraph compat: the legacy subgraph keys .eth Registrations by labelHash.
  // Otherwise use node for cross-registrar uniqueness.
  if (IS_SUBGRAPH_COMPAT) return labelHash;
  return node;
}

// ─── Label Encoding ─────────────────────────────────────────────────────────

export function encodeLabelHash(labelHash: string): string {
  return `[${labelHash.slice(2)}]`;
}

// ─── Account Upsert ─────────────────────────────────────────────────────────

export function upsertAccount(context: handlerContext, address: string): void {
  const existing = context.subgraph_accounts.getOrCreate({
    id: address,
  });
  // getOrCreate handles the upsert - if exists returns existing, else creates
  // But since Account only has id, we can just set it unconditionally
  context.subgraph_accounts.set({ id: address });
}

// ─── Resolver Upsert ────────────────────────────────────────────────────────

export async function upsertResolver(
  context: handlerContext,
  values: {
    id: string;
    domain_id: string;
    address: string;
    addr_id?: string | undefined;
    content_hash?: string | undefined;
    coin_types?: readonly bigint[] | undefined;
    texts?: readonly string[] | undefined;
  },
): Promise<{
  id: string;
  domain_id: string;
  address: string;
  addr_id: string | undefined;
  content_hash: string | undefined;
  texts: readonly string[] | undefined;
  coin_types: readonly bigint[] | undefined;
}> {
  const existing = await context.subgraph_resolvers.get(values.id);
  if (existing) {
    const updated = {
      ...existing,
      ...values,
    };
    context.subgraph_resolvers.set(updated);
    return updated;
  }
  const newResolver = {
    id: values.id,
    domain_id: values.domain_id,
    address: values.address,
    addr_id: values.addr_id,
    content_hash: values.content_hash,
    texts: values.texts,
    coin_types: values.coin_types,
  };
  context.subgraph_resolvers.set(newResolver);
  return newResolver;
}

// ─── Registration Upsert ────────────────────────────────────────────────────

export async function upsertRegistration(
  context: handlerContext,
  values: {
    id: string;
    domain_id: string;
    registration_date: bigint;
    expiry_date: bigint;
    registrant_id: string;
    label_name?: string | undefined;
    cost?: bigint | undefined;
  },
): Promise<void> {
  const existing = await context.subgraph_registrations.get(values.id);
  if (existing) {
    // Drop undefined-valued keys so they don't overwrite existing values —
    // matches drizzle's update semantics in the reference (undefined = no change)
    const defined = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v !== undefined),
    );
    context.subgraph_registrations.set({
      ...existing,
      ...defined,
    } as typeof existing);
  } else {
    context.subgraph_registrations.set({
      id: values.id,
      domain_id: values.domain_id,
      registration_date: values.registration_date,
      expiry_date: values.expiry_date,
      registrant_id: values.registrant_id,
      label_name: values.label_name,
      cost: values.cost,
    });
  }
}

// ─── Shared Event Values ────────────────────────────────────────────────────

export function sharedEventValues(
  chainId: number,
  event: {
    block: { number: number };
    logIndex: number;
    transaction: { hash: string };
  },
) {
  return {
    id: makeEventId(chainId, event.block.number, event.logIndex),
    block_number: event.block.number,
    transaction_id: event.transaction.hash,
  };
}

// ─── Domain Empty Check / Garbage Collection ────────────────────────────────

function isDomainEmpty(domain: Domain): boolean {
  return (
    domain.resolver_id === undefined &&
    domain.owner_id === ZERO_ADDRESS &&
    domain.subdomain_count === 0
  );
}

export async function recursivelyRemoveEmptyDomainFromParentSubdomainCount(
  context: handlerContext,
  node: string,
): Promise<void> {
  const domain = await context.subgraph_domains.get(node);
  if (!domain) return;

  if (isDomainEmpty(domain) && domain.parent_id !== undefined) {
    const parent = await context.subgraph_domains.get(domain.parent_id);
    if (parent) {
      context.subgraph_domains.set({
        ...parent,
        subdomain_count: parent.subdomain_count - 1,
      });
    }

    // recurse to parent
    return recursivelyRemoveEmptyDomainFromParentSubdomainCount(
      context,
      domain.parent_id,
    );
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

export function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function uniq<T>(arr: readonly T[]): T[] {
  return [...new Set(arr)];
}

// ─── Name Preimage ──────────────────────────────────────────────────────────

/**
 * Shared logic for controller NameRegistered/NameRenewed events that provide
 * the plaintext label. Updates the Domain's label_name/name and the
 * Registration's label_name/cost.
 */
export async function setNamePreimage(
  context: handlerContext,
  label_name: string,
  labelHash: string,
  cost: bigint,
  managedNode: string,
  managedName: string,
): Promise<void> {
  // NOTE(subgraph-compat): if the label is not subgraph-indexable, the legacy
  // subgraph ignores the event entirely.
  if (IS_SUBGRAPH_COMPAT && !isLabelSubgraphIndexable(label_name)) return;

  const node = makeSubdomainNode(labelHash, managedNode);
  const domain = await context.subgraph_domains.get(node);
  if (!domain) return;

  // The emitted label is a Literal Label. Subgraph compat: a subgraph-indexable
  // Literal Label is stored as-is. Otherwise interpret it (keep if ENSIP-15
  // normalized, else replace with the Encoded LabelHash of its literal bytes),
  // matching the reference ENSIndexer in SUBGRAPH_COMPAT=false mode.
  const interpretedLabel = IS_SUBGRAPH_COMPAT
    ? label_name
    : literalLabelToInterpretedLabel(label_name);

  // Update Domain label_name and name if different
  if (domain.label_name !== interpretedLabel) {
    const name = `${interpretedLabel}.${managedName}`;
    context.subgraph_domains.set({
      ...domain,
      label_name: interpretedLabel,
      name,
    });
  }

  // Update Registration label_name and cost
  const registrationId = makeRegistrationId(labelHash, node);
  const registration = await context.subgraph_registrations.get(registrationId);
  if (registration) {
    context.subgraph_registrations.set({
      ...registration,
      label_name: interpretedLabel,
      cost,
    });
  }
}

// ─── String Utilities ───────────────────────────────────────────────────────

export function hasNullByte(str: string): boolean {
  return str.includes("\0");
}

export function stripNullBytes(str: string): string {
  return str.replace(/\0/g, "");
}

// ─── DNS Decoding ──────────────────────────────────────────────────────────

/**
 * Decode a DNS wire-format encoded name (hex bytes) into an array of labels.
 * e.g. 0x03666f6f03657468​00 → ["foo", "eth"]
 */
export function decodeDnsEncodedName(data: string): string[] {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const bytes = Buffer.from(hex, "hex");
  const labels: string[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const labelLen = bytes[offset]!;
    offset += 1;
    if (labelLen === 0) break;
    if (offset + labelLen > bytes.length) break;

    const labelBytes = bytes.subarray(offset, offset + labelLen);
    offset += labelLen;
    labels.push(labelBytes.toString("utf8"));
  }

  return labels;
}

// ─── Root Domain ───────────────────────────────────────────────────────────

/**
 * Ensure the root domain (0x000...000) exists. Idempotent — skips if
 * the root domain has already been created.
 *
 * Matches the reference `setupRootNode`: created_at is 0, the root is
 * considered migrated, and (in SUBGRAPH_COMPAT=false mode) its name is the
 * ENS Root Name '' (empty string).
 */
export async function ensureRootDomain(
  context: handlerContext,
): Promise<void> {
  const existingRoot = await context.subgraph_domains.get(ROOT_NODE);
  if (!existingRoot) {
    upsertAccount(context, ZERO_ADDRESS);
    context.subgraph_domains.set({
      id: ROOT_NODE,
      // subgraph datamodel expects null for the root's name; otherwise the
      // root's Interpreted Name is '' (empty string)
      name: IS_SUBGRAPH_COMPAT ? undefined : "",
      label_name: undefined,
      labelhash: undefined,
      parent_id: undefined,
      subdomain_count: 0,
      resolved_address_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      is_migrated: true,
      created_at: 0n,
      owner_id: ZERO_ADDRESS,
      registrant_id: undefined,
      wrapped_owner_id: undefined,
      expiry_date: undefined,
    });
  }
}
