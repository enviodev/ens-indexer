import { keccak256, encodePacked, zeroAddress } from "viem";
import type { EvmOnEventContext, Entity } from "envio";

export type handlerContext = EvmOnEventContext;
export type Domain = Entity<"subgraph_domain">;

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

// Set of all managed registrar nodes (for NameWrapper expiryDate preservation)
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

export function makeResolverId(
  resolverAddress: string,
  node: string,
): string {
  return `${chainId}-${resolverAddress}-${node}`;
}

export function makeEventId(
  blockNumber: number,
  logIndex: number,
  transferIndex?: number,
): string {
  const parts = [chainId, blockNumber, logIndex];
  if (transferIndex !== undefined) {
    return `${parts.join("-")}-${transferIndex}`;
  }
  return parts.join("-");
}

export function makeRegistrationId(labelHash: string, node: string): string {
  // Use node for cross-registrar uniqueness
  return node;
}

// ─── Label Encoding ─────────────────────────────────────────────────────────

export function encodeLabelHash(labelHash: string): string {
  return `[${labelHash.slice(2)}]`;
}

// ─── Account Upsert ─────────────────────────────────────────────────────────

export function upsertAccount(context: handlerContext, address: string): void {
  const existing = context.subgraph_account.getOrCreate({
    id: address,
  });
  // getOrCreate handles the upsert - if exists returns existing, else creates
  // But since Account only has id, we can just set it unconditionally
  context.subgraph_account.set({ id: address });
}

// ─── Resolver Upsert ────────────────────────────────────────────────────────

export async function upsertResolver(
  context: handlerContext,
  values: {
    id: string;
    domain_id: string;
    address: string;
    addr_id?: string | undefined;
    contentHash?: string | undefined;
    coinTypes?: readonly bigint[] | undefined;
    texts?: readonly string[] | undefined;
  },
): Promise<{
  id: string;
  domain_id: string;
  address: string;
  addr_id: string | undefined;
  contentHash: string | undefined;
  texts: readonly string[] | undefined;
  coinTypes: readonly bigint[] | undefined;
}> {
  const existing = await context.subgraph_resolver.get(values.id);
  if (existing) {
    const updated = {
      ...existing,
      ...values,
    };
    context.subgraph_resolver.set(updated);
    return updated;
  }
  const newResolver = {
    id: values.id,
    domain_id: values.domain_id,
    address: values.address,
    addr_id: values.addr_id,
    contentHash: values.contentHash,
    texts: values.texts,
    coinTypes: values.coinTypes,
  };
  context.subgraph_resolver.set(newResolver);
  return newResolver;
}

// ─── Registration Upsert ────────────────────────────────────────────────────

export async function upsertRegistration(
  context: handlerContext,
  values: {
    id: string;
    domain_id: string;
    registrationDate: bigint;
    expiryDate: bigint;
    registrant_id: string;
    labelName?: string | undefined;
    cost?: bigint | undefined;
  },
): Promise<void> {
  const existing = await context.subgraph_registration.get(values.id);
  if (existing) {
    context.subgraph_registration.set({
      ...existing,
      ...values,
    });
  } else {
    context.subgraph_registration.set({
      id: values.id,
      domain_id: values.domain_id,
      registrationDate: values.registrationDate,
      expiryDate: values.expiryDate,
      registrant_id: values.registrant_id,
      labelName: values.labelName,
      cost: values.cost,
    });
  }
}

// ─── Shared Event Values ────────────────────────────────────────────────────

export function sharedEventValues(
  event: {
    block: { number: number };
    logIndex: number;
    transaction: { hash: string };
  },
) {
  return {
    id: makeEventId(chainId, event.block.number, event.logIndex),
    blockNumber: event.block.number,
    transactionID: event.transaction.hash,
  };
}

// ─── Domain Empty Check / Garbage Collection ────────────────────────────────

function isDomainEmpty(domain: Domain): boolean {
  return (
    domain.resolver_id === undefined &&
    domain.owner_id === ZERO_ADDRESS &&
    domain.subdomainCount === 0
  );
}

export async function recursivelyRemoveEmptyDomainFromParentSubdomainCount(
  context: handlerContext,
  node: string,
): Promise<void> {
  const domain = await context.subgraph_domain.get(node);
  if (!domain) return;

  if (isDomainEmpty(domain) && domain.parent_id !== undefined) {
    const parent = await context.subgraph_domain.get(domain.parent_id);
    if (parent) {
      context.subgraph_domain.set({
        ...parent,
        subdomainCount: parent.subdomainCount - 1,
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
 * the plaintext label. Updates the Domain's labelName/name and the
 * Registration's labelName/cost.
 */
export async function setNamePreimage(
  context: handlerContext,
  labelName: string,
  labelHash: string,
  cost: bigint,
  managedNode: string,
  managedName: string,
): Promise<void> {
  const node = makeSubdomainNode(labelHash, managedNode);
  const domain = await context.subgraph_domain.get(node);
  if (!domain) return;

  // Sanitize label: skip if it contains null bytes (subgraph compat)
  const sanitizedLabel = hasNullByte(labelName)
    ? stripNullBytes(labelName)
    : labelName;

  // Update Domain labelName and name if different
  if (domain.labelName !== sanitizedLabel) {
    const name = `${sanitizedLabel}.${managedName}`;
    context.subgraph_domain.set({
      ...domain,
      labelName: sanitizedLabel,
      name,
    });
  }

  // Update Registration labelName and cost
  const registrationId = makeRegistrationId(labelHash, node);
  const registration = await context.subgraph_registration.get(registrationId);
  if (registration) {
    context.subgraph_registration.set({
      ...registration,
      labelName: sanitizedLabel,
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
 */
export async function ensureRootDomain(
  context: handlerContext,
  timestamp: bigint,
): Promise<void> {
  const existingRoot = await context.subgraph_domain.get(ROOT_NODE);
  if (!existingRoot) {
    upsertAccount(context, ZERO_ADDRESS);
    context.subgraph_domain.set({
      id: ROOT_NODE,
      name: undefined,
      labelName: undefined,
      labelhash: undefined,
      parent_id: undefined,
      subdomainCount: 0,
      resolvedAddress_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      isMigrated: true,
      createdAt: timestamp,
      owner_id: ZERO_ADDRESS,
      registrant_id: undefined,
      wrappedOwner_id: undefined,
      expiryDate: undefined,
    });
  }
}
