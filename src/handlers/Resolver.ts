import { indexer } from "envio";
import type { handlerContext } from "../lib/helpers";
import {
  makeResolverId,
  upsertAccount,
  upsertResolver,
  sharedEventValues,
  uniq,
  hasNullByte,
  stripNullBytes,
  decodeDnsEncodedName,
  emptyToUndefined,
  isIndexable,
  ADDR_REVERSE_NODE,
  setDomain,
} from "../lib/helpers";

import {
  ETH_COIN_TYPE,
  bigintToCoinType,
  ensurePAResolver,
  ensurePAResolverRecords,
  handlePAAddressRecordUpdate,
  handlePATextRecordUpdate,
  handlePANameUpdate,
  addressForReverseLabel,
  upsertReverseNameRecord,
  interpretTextRecordKey,
  interpretTextRecordValue,
} from "../lib/protocol-acceleration";

import { onResolverChains } from "../lib/resolver-chains";
import { V2_DEPLOYMENTS } from "../lib/v2-deployments";
import { makeV2RegistryId } from "../lib/v2-helpers";
import { emitNameEvent } from "../lib/name-events";

import dnsPacket, { type Answer } from "dns-packet";

// Resolver events are matched by signature on any address and applied whether or
// not a registry has assigned the resolver, as the ENS subgraph does (its Resolver
// data source has no address and no start block). Records set before a name points
// at a resolver are therefore kept, and NewResolver picks them up. Watching
// resolvers by address instead loses events when HyperIndex registers an address late.

// ─── AddrChanged ─────────────────────────────────────────────────────────────
// Emitted when the ETH address for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "AddrChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, a } = event.params;

  // upsert Account for the ETH address
  upsertAccount(context, a);

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver with the new addr
  const resolver = await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
    addr_id: a,
  });

  // legacy AddrChanged is the coin type 60 record: list it in coinTypes
  context.Subgraph_resolver.set({
    ...resolver,
    coinTypes: uniq([...(resolver.coinTypes ?? []), BigInt(ETH_COIN_TYPE)]),
  });

  // materialize Domain.resolvedAddress_id if Domain.resolver_id matches
  const domain = await context.Subgraph_domain.get(node);
  if (domain && domain.resolver_id === resolverId) {
    setDomain(context, {
      ...domain,
      resolvedAddress_id: a,
    });
  }

  // log AddrChanged
  context.Subgraph_addr_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    addr_id: a,
  });

  // PA: track ETH address record
  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  handlePAAddressRecordUpdate(context, event.chainId, event.srcAddress, node, ETH_COIN_TYPE, a);
  },
);

// ─── AddressChanged (multicoin) ──────────────────────────────────────────────
// Emitted when a multicoin address changes for a node.

indexer.onEvent(
  { contract: "Resolver", event: "AddressChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, coinType, newAddress } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  const resolver = await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // add coinType to resolver's coinTypes array
  context.Subgraph_resolver.set({
    ...resolver,
    coinTypes: uniq([...(resolver.coinTypes ?? []), coinType]),
  });

  // log MulticoinAddrChanged
  context.Subgraph_multicoin_addr_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    coinType,
    addr: newAddress,
  });

  // PA: track multicoin address record
  const paCoinType = bigintToCoinType(coinType);
  if (paCoinType !== null) {
    ensurePAResolver(context, event.chainId, event.srcAddress);
    ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
    handlePAAddressRecordUpdate(context, event.chainId, event.srcAddress, node, paCoinType, newAddress);
  }
  },
);

// ─── Legacy primary names ────────────────────────────────────────────────────
// The name record of an `<address>.addr.reverse` node is the address's coin type
// 60 reverse record (H-04). Mainnet only.

async function applyLegacyReverseName(
  context: handlerContext,
  event: { chainId: number; srcAddress: string; block: { number: number; timestamp: number }; logIndex: number; transaction: { hash: string; from?: string | undefined } },
  node: string,
  resolverId: string,
  name: string,
): Promise<void> {
  if (event.chainId !== 1) return;
  const reverseDomain = await context.Subgraph_domain.get(node);
  // Only the resolver the registry assigns to the reverse node can set it.
  // Without this check any watched resolver could claim another address's name.
  if (reverseDomain?.parent_id !== ADDR_REVERSE_NODE || reverseDomain.resolver_id !== resolverId) return;
  const claim = await context.Reverse_claim.get(node);
  const address = addressForReverseLabel(reverseDomain.labelhash, [
    claim?.addr,
    reverseDomain.owner_id,
    event.transaction.from,
  ]);
  if (address !== null) {
    upsertReverseNameRecord(context, address, ETH_COIN_TYPE, name);
    emitNameEvent(context, event, {
      kind: "PRIMARY_NAME", protocol: "v1", node, address, name: name === "" ? undefined : name,
      detail: { coinType: ETH_COIN_TYPE, source: "legacy reverse resolver", resolver: event.srcAddress.toLowerCase() },
    });
    context.Unrecovered_reverse_name.deleteUnsafe(node);
  } else if (isIndexable(name)) {
    context.Unrecovered_reverse_name.set({
      id: node,
      name,
      blockNumber: event.block.number,
    });
  }
}

// ─── NameChanged ─────────────────────────────────────────────────────────────
// Emitted when the name for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "NameChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, name } = event.params;

  // skip if name contains null bytes
  if (hasNullByte(name)) return;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // log NameChanged
  context.Subgraph_name_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    name,
  });

  // PA: track name record
  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  await handlePANameUpdate(context, event.chainId, event.srcAddress, node, name);

  await applyLegacyReverseName(context, event, node, resolverId, name);
  },
);

// ─── ABIChanged ──────────────────────────────────────────────────────────────
// Emitted when the ABI for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "ABIChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, contentType } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // log AbiChanged
  context.Subgraph_abi_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    contentType,
  });
  },
);

// ─── PubkeyChanged ──────────────────────────────────────────────────────────
// Emitted when the public key for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "PubkeyChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, x, y } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // log PubkeyChanged
  context.Subgraph_pubkey_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    x,
    y,
  });
  },
);

// ─── TextChanged ─────────────────────────────────────────────────────────────
// Emitted when a text record for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "TextChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, key, value } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  const resolver = await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // sanitize key and value (strip null bytes)
  const sanitizedKey = stripNullBytes(key);

  // empty or undefined value becomes undefined
  const sanitizedValue =
    value === undefined || value === ""
      ? undefined
      : stripNullBytes(value) || undefined;

  // add sanitized key to resolver's texts array
  context.Subgraph_resolver.set({
    ...resolver,
    texts: uniq([...(resolver.texts ?? []), sanitizedKey]),
  });

  // log TextChanged
  context.Subgraph_text_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    key: sanitizedKey,
    value: sanitizedValue,
  });

  // PA: track text record
  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  handlePATextRecordUpdate(context, event.chainId, event.srcAddress, node, key, value ?? null);
  },
);

// ─── ContenthashChanged ─────────────────────────────────────────────────────
// Emitted when the content hash for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "ContenthashChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, hash } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver with the new contentHash
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
    contentHash: emptyToUndefined(hash),
  });

  // log ContenthashChanged
  context.Subgraph_contenthash_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    hash,
  });
  },
);

// ─── InterfaceChanged ────────────────────────────────────────────────────────
// Emitted when the EIP-165 interface support changes for a node.

indexer.onEvent(
  { contract: "Resolver", event: "InterfaceChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, interfaceID, implementer } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // log InterfaceChanged
  context.Subgraph_interface_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    interfaceID,
    implementer,
  });
  },
);

// ─── AuthorisationChanged ───────────────────────────────────────────────────
// Emitted when an authorisation for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "AuthorisationChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, owner, target, isAuthorised } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // log AuthorisationChanged
  // NOTE: the spelling difference is kept for subgraph backwards-compatibility
  context.Subgraph_authorisation_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    owner,
    target,
    isAuthorized: isAuthorised,
  });
  },
);

// ─── VersionChanged ─────────────────────────────────────────────────────────
// Emitted when the resolver version changes, clearing all stored data.

indexer.onEvent(
  { contract: "Resolver", event: "VersionChanged", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, newVersion } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // materialize Domain.resolvedAddress_id to undefined if Domain.resolver_id matches
  const domain = await context.Subgraph_domain.get(node);
  if (domain && domain.resolver_id === resolverId) {
    setDomain(context, {
      ...domain,
      resolvedAddress_id: undefined,
    });
  }

  // upsert Resolver with ALL fields cleared
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
    addr_id: undefined,
    contentHash: undefined,
    coinTypes: undefined,
    texts: undefined,
  });

  // log VersionChanged
  context.Subgraph_version_changed.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    version: newVersion,
  });

  // The record tables the API reads are cleared too (the subgraph has none: its
  // Resolver row above is all it clears). The contract drops every record of the
  // node: addresses, texts and the name, which on a reverse node is a primary name.
  const address = event.srcAddress;
  for (const row of await context.Resolver_address_record.getWhere({ address: { _eq: address }, node: { _eq: node } })) {
    context.Resolver_address_record.deleteUnsafe(row.id);
  }
  for (const row of await context.Resolver_text_record.getWhere({ address: { _eq: address }, node: { _eq: node } })) {
    context.Resolver_text_record.deleteUnsafe(row.id);
  }
  await handlePANameUpdate(context, event.chainId, address, node, "");
  await applyLegacyReverseName(context, event, node, resolverId, "");

  // The ENSv2 node-keyed copies of this node's records (src/handlers/V2NodeResolver.ts)
  // are cleared too, or the API would still read them.
  if (V2_DEPLOYMENTS[event.chainId]) {
    const resolver = event.srcAddress.toLowerCase();
    context.V2_node_record.deleteUnsafe(`${makeV2RegistryId(event.chainId, resolver)}-${node}`);
    for (const row of await context.V2_node_address.getWhere({ resolver: { _eq: resolver }, node: { _eq: node } })) {
      context.V2_node_address.deleteUnsafe(row.id);
    }
    for (const row of await context.V2_node_text.getWhere({ resolver: { _eq: resolver }, node: { _eq: node } })) {
      context.V2_node_text.deleteUnsafe(row.id);
    }
  }
  },
);

// ─── DNS Record Helpers (PA only) ──────────────────────────────────────────

function parseRRSet(record: string): Answer[] {
  const data = Buffer.from(record.slice(2), "hex");
  let offset = 0;
  const decodedRecords: Answer[] = [];

  while (offset < data.length) {
    let answer: Answer | undefined;
    try {
      answer = (dnsPacket as any).answer.decode(data, offset);
    } catch {}

    if (!answer) break;
    if ((answer.type as string) === "UNKNOWN_0") break;

    const consumedLength = (dnsPacket as any).answer.encodingLength(answer);
    if (consumedLength === 0) break;

    decodedRecords.push(answer);
    offset += consumedLength;
  }

  return decodedRecords;
}

function decodeTXTData(data: Buffer[]): string | null {
  const decoded = data.map((buf) => buf.toString());
  if (decoded.length === 0) return null;
  return decoded[0]!;
}

function parseDnsTxtRecordArgs({
  name,
  resource,
  record,
}: {
  name: string;
  resource: bigint;
  record?: string;
}): { key: string | null; value: string | null } {
  // ignore records that are not TXT records (resource id 16)
  if (resource !== 16n) return { key: null, value: null };

  // parse the record's name (DNS wire format)
  const recordName = decodeDnsEncodedName(name).join(".");

  // ignore keys that don't end with .ens
  if (!recordName.endsWith(".ens")) return { key: null, value: null };

  // trim the .ens suffix to match ENS record naming
  const key = interpretTextRecordKey(recordName.slice(0, -4));
  if (key === null) return { key: null, value: null };

  // no record? interpret as deletion
  if (!record) return { key, value: null };

  // parse the RRSet from the record parameter
  const answers = parseRRSet(record);

  const txtDatas = answers
    .filter((answer) => answer.type === "TXT")
    .map((answer) => decodeTXTData(answer.data as Buffer[]));

  if (txtDatas.length === 0) return { key, value: null };

  const value = txtDatas[0]!;
  return { key, value: interpretTextRecordValue(value) };
}

// Adds a DNS TXT record key to the resolver's texts list (H-23).
async function addDnsTextKey(
  context: handlerContext,
  chainId: number,
  resolverAddress: string,
  node: string,
  key: string,
): Promise<void> {
  const resolverId = makeResolverId(chainId, resolverAddress, node);
  const resolver = await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: resolverAddress,
  });
  context.Subgraph_resolver.set({
    ...resolver,
    texts: uniq([...(resolver.texts ?? []), key]),
  });
}

// ─── DNSRecordChanged (4-arg: without ttl) ──────────────────────────────────
// PA-only: indexes DNS TXT records as PA text records.

indexer.onEvent(
  { contract: "Resolver", event: "DNSRecordChanged4", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, name, resource, record } = event.params;
  const { key, value } = parseDnsTxtRecordArgs({ name, resource, record });
  if (key === null) return;

  if (value !== null) {
    await addDnsTextKey(context, event.chainId, event.srcAddress, node, key);
  }

  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  handlePATextRecordUpdate(context, event.chainId, event.srcAddress, node, key, value);
  },
);

// ─── DNSRecordChanged (5-arg: with ttl) ─────────────────────────────────────
// PA-only: indexes DNS TXT records as PA text records.

indexer.onEvent(
  { contract: "Resolver", event: "DNSRecordChanged5", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, name, resource, record } = event.params;
  const { key, value } = parseDnsTxtRecordArgs({ name, resource, record });
  if (key === null) return;

  if (value !== null) {
    await addDnsTextKey(context, event.chainId, event.srcAddress, node, key);
  }

  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  handlePATextRecordUpdate(context, event.chainId, event.srcAddress, node, key, value);
  },
);

// ─── DNSRecordDeleted ───────────────────────────────────────────────────────
// PA-only: deletes DNS TXT records from PA text records.

indexer.onEvent(
  { contract: "Resolver", event: "DNSRecordDeleted", wildcard: true, where: onResolverChains },
  async ({ event, context }) => {
  const { node, name, resource } = event.params;
  const { key } = parseDnsTxtRecordArgs({ name, resource });
  if (key === null) return;

  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  handlePATextRecordUpdate(context, event.chainId, event.srcAddress, node, key, null);
  },
);
