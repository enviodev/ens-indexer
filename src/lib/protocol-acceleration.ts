import { isAddress, isAddressEqual, zeroAddress } from "viem";
import { normalize } from "viem/ens";
import type { handlerContext } from "generated";
import { hasNullByte } from "./helpers";

// ─── Coin Type Constants ─────────────────────────────────────────────────────

export const ETH_COIN_TYPE = 60;
export const DEFAULT_EVM_COIN_TYPE = 0x8000_0000;

// ─── Coin Type Utilities ─────────────────────────────────────────────────────

/**
 * Converts a bigint value to a CoinType number.
 * Returns null if the value is too large to fit in Number.MAX_SAFE_INTEGER.
 */
export function bigintToCoinType(value: bigint): number | null {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

/**
 * Converts an EVM chain ID to a CoinType.
 * Chain ID 1 (mainnet) → ETH_COIN_TYPE (60).
 * Other chains → 0x80000000 | chainId (ENSIP-11).
 */
export function evmChainIdToCoinType(chainId: number): number {
  if (chainId === 1) return ETH_COIN_TYPE;
  return DEFAULT_EVM_COIN_TYPE | chainId;
}

// ─── ID Generators ───────────────────────────────────────────────────────────

export function makePAResolverId(chainId: number, address: string): string {
  return `${chainId}-${address}`;
}

export function makePAResolverRecordsId(
  chainId: number,
  address: string,
  node: string,
): string {
  return `${chainId}-${address}-${node}`;
}

export function makePAAddressRecordId(
  chainId: number,
  address: string,
  node: string,
  coinType: number,
): string {
  return `${chainId}-${address}-${node}-${coinType}`;
}

export function makePATextRecordId(
  chainId: number,
  address: string,
  node: string,
  key: string,
): string {
  return `${chainId}-${address}-${node}-${key}`;
}

export function makeDomainResolverRelationId(
  chainId: number,
  registryAddress: string,
  domainId: string,
): string {
  return `${chainId}-${registryAddress}-${domainId}`;
}

export function makeReverseNameRecordId(
  address: string,
  coinType: number,
): string {
  return `${address}-${coinType}`;
}

// ─── Interpretation Functions ────────────────────────────────────────────────

/**
 * Interprets a name record value. Returns null if the value should be treated
 * as a deletion (empty string, or not a normalized ENS name).
 */
export function interpretNameRecordValue(value: string): string | null {
  if (value === "") return null;

  try {
    if (normalize(value) !== value) return null;
  } catch {
    return null;
  }

  return value;
}

/**
 * Interprets an address record value. Returns null if the value should be
 * treated as a deletion (null bytes, empty, 0x, or zero address).
 * EVM addresses are lowercased.
 */
export function interpretAddressRecordValue(value: string): string | null {
  if (hasNullByte(value)) return null;
  if (value === "") return null;
  if (value === "0x") return null;
  if (!isAddress(value)) return value;
  if (isAddressEqual(value, zeroAddress)) return null;
  return value.toLowerCase();
}

/**
 * Interprets a text record key. Returns null if the key should be ignored
 * (null bytes or empty string).
 */
export function interpretTextRecordKey(key: string): string | null {
  if (hasNullByte(key)) return null;
  if (key === "") return null;
  return key;
}

/**
 * Interprets a text record value. Returns null if the value should be treated
 * as a deletion (null bytes or empty string). Null input → null output.
 */
export function interpretTextRecordValue(
  value: string | null,
): string | null {
  if (value === null) return null;
  if (hasNullByte(value)) return null;
  if (value === "") return null;
  return value;
}

// ─── DB Helper Functions ─────────────────────────────────────────────────────

/**
 * Ensures a PAResolver entity exists for the given chainId + address.
 */
export function ensurePAResolver(
  context: handlerContext,
  chainId: number,
  address: string,
): void {
  const id = makePAResolverId(chainId, address);
  context.PAResolver.set({
    id,
    chainId,
    address,
  });
}

/**
 * Ensures a PAResolverRecords entity exists for the given chainId + address + node.
 */
export function ensurePAResolverRecords(
  context: handlerContext,
  chainId: number,
  address: string,
  node: string,
): void {
  const id = makePAResolverRecordsId(chainId, address, node);
  context.PAResolverRecords.set({
    id,
    chainId,
    address,
    node,
    name: undefined,
    resolver_id: makePAResolverId(chainId, address),
  });
}

/**
 * Handles a PA address record update. Upserts or deletes based on interpretation.
 */
export function handlePAAddressRecordUpdate(
  context: handlerContext,
  chainId: number,
  address: string,
  node: string,
  coinType: number,
  rawValue: string,
): void {
  const interpretedValue = interpretAddressRecordValue(rawValue);
  const id = makePAAddressRecordId(chainId, address, node, coinType);

  if (interpretedValue === null) {
    context.PAResolverAddressRecord.deleteUnsafe(id);
  } else {
    context.PAResolverAddressRecord.set({
      id,
      chainId,
      address,
      node,
      coinType: BigInt(coinType),
      value: interpretedValue,
      resolverRecords_id: makePAResolverRecordsId(chainId, address, node),
    });
  }
}

/**
 * Handles a PA text record update. Upserts or deletes based on interpretation.
 */
export function handlePATextRecordUpdate(
  context: handlerContext,
  chainId: number,
  address: string,
  node: string,
  key: string,
  rawValue: string | null,
): void {
  const interpretedKey = interpretTextRecordKey(key);
  if (interpretedKey === null) return;

  const interpretedValue = interpretTextRecordValue(rawValue);
  const id = makePATextRecordId(chainId, address, node, interpretedKey);

  if (interpretedValue === null) {
    context.PAResolverTextRecord.deleteUnsafe(id);
  } else {
    context.PAResolverTextRecord.set({
      id,
      chainId,
      address,
      node,
      key: interpretedKey,
      value: interpretedValue,
      resolverRecords_id: makePAResolverRecordsId(chainId, address, node),
    });
  }
}

/**
 * Handles a PA name update on the PAResolverRecords entity.
 */
export async function handlePANameUpdate(
  context: handlerContext,
  chainId: number,
  address: string,
  node: string,
  rawName: string,
): Promise<void> {
  const interpretedName = interpretNameRecordValue(rawName);
  const id = makePAResolverRecordsId(chainId, address, node);

  const existing = await context.PAResolverRecords.get(id);
  if (existing) {
    context.PAResolverRecords.set({
      ...existing,
      name: interpretedName ?? undefined,
    });
  }
}

/**
 * Upserts or deletes a DomainResolverRelation.
 * If resolver is the zero address, the relation is deleted.
 */
export function upsertDomainResolverRelation(
  context: handlerContext,
  chainId: number,
  registryAddress: string,
  domainId: string,
  resolver: string,
): void {
  const id = makeDomainResolverRelationId(chainId, registryAddress, domainId);

  if (isAddressEqual(resolver as `0x${string}`, zeroAddress)) {
    context.DomainResolverRelation.deleteUnsafe(id);
  } else {
    context.DomainResolverRelation.set({
      id,
      chainId,
      address: registryAddress,
      domainId,
      resolver,
    });
  }
}

/**
 * Records that a node has been migrated to the new Registry contract.
 */
export function migrateNode(
  context: handlerContext,
  node: string,
): void {
  context.MigratedNode.set({ id: node });
}

/**
 * Returns whether a node has been migrated to the new Registry contract.
 */
export async function nodeIsMigrated(
  context: handlerContext,
  node: string,
): Promise<boolean> {
  const record = await context.MigratedNode.get(node);
  return !!record;
}

/**
 * Upserts or deletes a ReverseNameRecord.
 * If the interpreted name is null, the record is deleted.
 */
export function upsertReverseNameRecord(
  context: handlerContext,
  address: string,
  coinType: number,
  rawName: string,
): void {
  const interpretedValue = interpretNameRecordValue(rawName);
  const id = makeReverseNameRecordId(address, coinType);

  if (interpretedValue === null) {
    context.ReverseNameRecord.deleteUnsafe(id);
  } else {
    context.ReverseNameRecord.set({
      id,
      address,
      coinType: BigInt(coinType),
      value: interpretedValue,
    });
  }
}
