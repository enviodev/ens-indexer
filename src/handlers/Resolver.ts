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
} from "../lib/helpers";

import {
  ETH_COIN_TYPE,
  bigintToCoinType,
  ensurePAResolver,
  ensurePAResolverRecords,
  handlePAAddressRecordUpdate,
  handlePATextRecordUpdate,
  handlePANameUpdate,
  interpretTextRecordKey,
  interpretTextRecordValue,
} from "../lib/protocol-acceleration";

import dnsPacket, { type Answer } from "dns-packet";

// ─── AddrChanged ─────────────────────────────────────────────────────────────
// Emitted when the ETH address for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "AddrChanged" },
  async ({ event, context }) => {
  const { node, a } = event.params;

  // upsert Account for the ETH address
  upsertAccount(context, a);

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver with the new addr
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
    addr_id: a,
  });

  // materialize Domain.resolvedAddress_id if Domain.resolver_id matches
  const domain = await context.Domain.get(node);
  if (domain && domain.resolver_id === resolverId) {
    context.Domain.set({
      ...domain,
      resolvedAddress_id: a,
    });
  }

  // log AddrChanged
  context.AddrChanged.set({
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
  { contract: "Resolver", event: "AddressChanged" },
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
  context.Resolver.set({
    ...resolver,
    coinTypes: uniq([...(resolver.coinTypes ?? []), coinType]),
  });

  // log MulticoinAddrChanged
  context.MulticoinAddrChanged.set({
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

// ─── NameChanged ─────────────────────────────────────────────────────────────
// Emitted when the name for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "NameChanged" },
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
  context.NameChanged.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    name,
  });

  // PA: track name record
  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  await handlePANameUpdate(context, event.chainId, event.srcAddress, node, name);
  },
);

// ─── ABIChanged ──────────────────────────────────────────────────────────────
// Emitted when the ABI for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "ABIChanged" },
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
  context.AbiChanged.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    contentType,
  });
  },
);

// ─── PubkeyChanged ──────────────────────────────────────────────────────────
// Emitted when the public key for a node changes.

indexer.onEvent(
  { contract: "Resolver", event: "PubkeyChanged" },
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
  context.PubkeyChanged.set({
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
  { contract: "Resolver", event: "TextChanged" },
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
  context.Resolver.set({
    ...resolver,
    texts: uniq([...(resolver.texts ?? []), sanitizedKey]),
  });

  // log TextChanged
  context.TextChanged.set({
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
  { contract: "Resolver", event: "ContenthashChanged" },
  async ({ event, context }) => {
  const { node, hash } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver with the new contentHash
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
    contentHash: hash,
  });

  // log ContenthashChanged
  context.ContenthashChanged.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    hash,
  });
  },
);

// ─── InterfaceChanged ────────────────────────────────────────────────────────
// Emitted when the EIP-165 interface support changes for a node.

indexer.onEvent(
  { contract: "Resolver", event: "InterfaceChanged" },
  async ({ event, context }) => {
  const { node, interfaceID, implementer } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // log InterfaceChangedEvent
  context.InterfaceChangedEvent.set({
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
  { contract: "Resolver", event: "AuthorisationChanged" },
  async ({ event, context }) => {
  const { node, owner, target, isAuthorised } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // upsert Resolver
  await upsertResolver(context, {
    id: resolverId,
    domain_id: node,
    address: event.srcAddress,
  });

  // log AuthorisationChangedEvent
  // NOTE: the spelling difference is kept for subgraph backwards-compatibility
  context.AuthorisationChangedEvent.set({
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
  { contract: "Resolver", event: "VersionChanged" },
  async ({ event, context }) => {
  const { node, newVersion } = event.params;

  const resolverId = makeResolverId(event.chainId, event.srcAddress, node);

  // materialize Domain.resolvedAddress_id to undefined if Domain.resolver_id matches
  const domain = await context.Domain.get(node);
  if (domain && domain.resolver_id === resolverId) {
    context.Domain.set({
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

  // log VersionChangedEvent
  context.VersionChangedEvent.set({
    ...sharedEventValues(event.chainId, event),
    resolver_id: resolverId,
    version: newVersion,
  });
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

// ─── DNSRecordChanged (4-arg: without ttl) ──────────────────────────────────
// PA-only: indexes DNS TXT records as PA text records.

indexer.onEvent(
  { contract: "Resolver", event: "DNSRecordChanged4" },
  async ({ event, context }) => {
  const { node, name, resource, record } = event.params;
  const { key, value } = parseDnsTxtRecordArgs({ name, resource, record });
  if (key === null) return;

  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  handlePATextRecordUpdate(context, event.chainId, event.srcAddress, node, key, value);
  },
);

// ─── DNSRecordChanged (5-arg: with ttl) ─────────────────────────────────────
// PA-only: indexes DNS TXT records as PA text records.

indexer.onEvent(
  { contract: "Resolver", event: "DNSRecordChanged5" },
  async ({ event, context }) => {
  const { node, name, resource, record } = event.params;
  const { key, value } = parseDnsTxtRecordArgs({ name, resource, record });
  if (key === null) return;

  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  handlePATextRecordUpdate(context, event.chainId, event.srcAddress, node, key, value);
  },
);

// ─── DNSRecordDeleted ───────────────────────────────────────────────────────
// PA-only: deletes DNS TXT records from PA text records.

indexer.onEvent(
  { contract: "Resolver", event: "DNSRecordDeleted" },
  async ({ event, context }) => {
  const { node, name, resource } = event.params;
  const { key } = parseDnsTxtRecordArgs({ name, resource });
  if (key === null) return;

  ensurePAResolver(context, event.chainId, event.srcAddress);
  ensurePAResolverRecords(context, event.chainId, event.srcAddress, node);
  handlePATextRecordUpdate(context, event.chainId, event.srcAddress, node, key, null);
  },
);
