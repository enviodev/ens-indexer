import { indexer } from "envio";

import {
  ETH_NODE,
  GRACE_PERIOD_SECONDS,
  makeSubdomainNode,
  makeRegistrationId,
  makeEventId,
  upsertAccount,
  upsertRegistration,
  sharedEventValues,
  tokenIdToLabelHash,
  setNamePreimage,
  ZERO_ADDRESS,
} from "../lib/helpers";
import { zeroAddress } from "viem";

import {
  handleRegistrarRegistration,
  handleRegistrarRenewal,
  handleRegistrarControllerEvent,
  handleUniversalRenewalEvent,
  decodeEncodedReferrer,
} from "../lib/registrar-helpers";

import {
  handleNFTTransfer,
  buildDomainAssetId,
  AssetNamespaces,
} from "../lib/tokenscope-helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

const managedNode = ETH_NODE;
const managedName = "eth";

// ─── BaseRegistrar Handlers ─────────────────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.id);
  const owner = event.params.owner;
  const expires = event.params.expires;

  // Upsert account for the owner
  upsertAccount(context, owner);

  // Compute the node for this .eth subdomain
  const node = makeSubdomainNode(labelHash, managedNode);

  // Get or create the domain
  let domain = await context.Domain.get(node);
  if (!domain) {
    // Handle preminted names edge case: if domain doesn't exist yet,
    // create it (normally Registry.NewOwner creates it first)
    domain = {
      id: node,
      name: undefined,
      labelName: undefined,
      labelhash: labelHash,
      parent_id: managedNode,
      subdomainCount: 0,
      resolvedAddress_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      isMigrated: true,
      createdAt: BigInt(event.block.timestamp),
      owner_id: owner,
      registrant_id: owner,
      wrappedOwner_id: undefined,
      expiryDate: expires + GRACE_PERIOD_SECONDS,
    };
    context.Domain.set(domain);
  } else {
    // Update existing domain with registrant and expiry
    context.Domain.set({
      ...domain,
      registrant_id: owner,
      expiryDate: expires + GRACE_PERIOD_SECONDS,
    });
  }

  // Upsert Registration
  const registrationId = makeRegistrationId(labelHash, node);
  await upsertRegistration(context, {
    id: registrationId,
    domain_id: node,
    registrationDate: BigInt(event.block.timestamp),
    expiryDate: expires,
    registrant_id: owner,
  });

  // Log NameRegistered
  context.NameRegistered.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    registrant_id: owner,
    expiryDate: expires,
  });

  // Registrar: track registration action
  await handleRegistrarRegistration(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    chainId: event.chainId,
    contractAddress: event.srcAddress,
    managedNode,
    labelHash,
    registrant: event.transaction.from ?? zeroAddress,
    expiresAt: expires,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── BaseRegistrar.NameRenewed ──────────────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar", event: "NameRenewed" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.id);
  const expires = event.params.expires;

  const node = makeSubdomainNode(labelHash, managedNode);
  const registrationId = makeRegistrationId(labelHash, node);

  // Update Registration expiryDate
  const registration = await context.Registration.get(registrationId);
  if (registration) {
    context.Registration.set({
      ...registration,
      expiryDate: expires,
    });
  }

  // Update Domain expiryDate (includes grace period)
  const domain = await context.Domain.get(node);
  if (domain) {
    context.Domain.set({
      ...domain,
      expiryDate: expires + GRACE_PERIOD_SECONDS,
    });
  }

  // Log NameRenewed
  context.NameRenewed.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    expiryDate: expires,
  });

  // Registrar: track renewal action
  await handleRegistrarRenewal(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    chainId: event.chainId,
    contractAddress: event.srcAddress,
    managedNode,
    labelHash,
    registrant: event.transaction.from ?? zeroAddress,
    expiresAt: expires,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── BaseRegistrar.Transfer ─────────────────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar", event: "Transfer" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.tokenId);
  const to = event.params.to;

  // Always upsert account for `to` (subgraph compat)
  upsertAccount(context, to);

  const node = makeSubdomainNode(labelHash, managedNode);
  const registrationId = makeRegistrationId(labelHash, node);

  // If the Transfer event occurs before the Registration entity exists
  // (i.e. initial registration ordering: Transfer -> NewOwner -> NameRegistered), no-op
  const registration = await context.Registration.get(registrationId);
  if (!registration) return;

  // Update Registration registrant
  context.Registration.set({
    ...registration,
    registrant_id: to,
  });

  // Update Domain registrant
  const domain = await context.Domain.get(node);
  if (domain) {
    context.Domain.set({
      ...domain,
      registrant_id: to,
    });
  }

  // Log NameTransferredEvent
  context.NameTransferredEvent.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    newOwner_id: to,
  });

  // TokenScope: track ERC721 transfer
  const nft = buildDomainAssetId(
    event.chainId,
    event.srcAddress,
    event.params.tokenId,
    AssetNamespaces.ERC721,
    (tokenId) => makeSubdomainNode(tokenIdToLabelHash(tokenId), managedNode),
  );
  await handleNFTTransfer(context, event.params.from, to, false, nft);
  },
);

// ─── LegacyController Handlers ─────────────────────────────────────────────

/**
 * LegacyController.NameRegistered provides the plaintext name.
 * event.params: { name: string (label), label: string (labelHash), owner, cost, expires }
 */
indexer.onEvent(
  { contract: "LegacyController", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);

  // Registrar: update action with pricing
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: cost,
    premium: 0n,
    total: cost,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

/**
 * LegacyController.NameRenewed provides the plaintext name on renewal.
 * event.params: { name: string (label), label: string (labelHash), cost, expires }
 */
indexer.onEvent(
  { contract: "LegacyController", event: "NameRenewed" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);

  // Registrar: update action with pricing
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: cost,
    premium: 0n,
    total: cost,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── WrappedController Handlers ─────────────────────────────────────────────

/**
 * WrappedController.NameRegistered provides the plaintext name.
 * event.params: { name, label (labelHash), owner, baseCost, premium, expires }
 * cost = baseCost + premium
 */
indexer.onEvent(
  { contract: "WrappedController", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const baseCost = event.params.baseCost;
  const premium = event.params.premium;
  const cost = baseCost + premium;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);

  // Registrar: update action with pricing
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost,
    premium,
    total: cost,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

/**
 * WrappedController.NameRenewed provides the plaintext name on renewal.
 * event.params: { name, label (labelHash), cost, expires }
 */
indexer.onEvent(
  { contract: "WrappedController", event: "NameRenewed" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);

  // Registrar: update action with pricing
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: cost,
    premium: 0n,
    total: cost,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── UnwrappedController Handlers ───────────────────────────────────────────

/**
 * UnwrappedController.NameRegistered provides the plaintext name.
 * event.params: { label (plaintext), labelhash (bytes32), owner, baseCost, premium, expires, referrer }
 * cost = baseCost + premium
 */
indexer.onEvent(
  { contract: "UnwrappedController", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelName = event.params.label; // plaintext label
  const labelHash = event.params.labelhash; // bytes32 labelHash
  const baseCost = event.params.baseCost;
  const premium = event.params.premium;
  const cost = baseCost + premium;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);

  // Registrar: update action with pricing and referral
  const node = makeSubdomainNode(labelHash, managedNode);
  const encodedReferrer = event.params.referrer;
  const decodedReferrer = decodeEncodedReferrer(encodedReferrer);

  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost,
    premium,
    total: cost,
    encodedReferrer,
    decodedReferrer,
    transactionHash: event.transaction.hash,
  });
  },
);

/**
 * UnwrappedController.NameRenewed provides the plaintext name on renewal.
 * event.params: { label (plaintext), labelhash (bytes32), cost, expires, referrer }
 */
indexer.onEvent(
  { contract: "UnwrappedController", event: "NameRenewed" },
  async ({ event, context }) => {
  const labelName = event.params.label; // plaintext label
  const labelHash = event.params.labelhash; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);

  // Registrar: update action with pricing and referral
  const node = makeSubdomainNode(labelHash, managedNode);
  const encodedReferrer = event.params.referrer;
  const decodedReferrer = decodeEncodedReferrer(encodedReferrer);

  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: cost,
    premium: 0n,
    total: cost,
    encodedReferrer,
    decodedReferrer,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── UniversalRenewal Handler ───────────────────────────────────────────────

indexer.onEvent(
  { contract: "UniversalRenewal", event: "RenewalReferred" },
  async ({ event, context }) => {
  const labelHash = event.params.labelHash;
  const node = makeSubdomainNode(labelHash, managedNode);
  const encodedReferrer = event.params.referrer;
  const decodedReferrer = decodeEncodedReferrer(encodedReferrer);

  await handleUniversalRenewalEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    encodedReferrer,
    decodedReferrer,
    transactionHash: event.transaction.hash,
  });
  },
);
