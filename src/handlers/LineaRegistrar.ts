import { indexer } from "envio";

import {
  LINEA_ETH_NODE,
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
} from "../lib/registrar-helpers";

import {
  handleNFTTransfer,
  buildDomainAssetId,
  AssetNamespaces,
} from "../lib/tokenscope-helpers";

import {
  IS_SUBGRAPH_COMPAT,
  isLabelSubgraphIndexable,
  healLabelByLabelHash,
  interpretHealedLabel,
} from "../lib/interpretation";

// ─── Constants ──────────────────────────────────────────────────────────────

const managedNode = LINEA_ETH_NODE;
const managedName = "linea.eth";

// ─── BaseRegistrar_Linea.NameRegistered ─────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar_Linea", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.id);
  const owner = event.params.owner;
  const expires = event.params.expires;

  upsertAccount(context, owner);

  const node = makeSubdomainNode(labelHash, managedNode);

  // Get or create the domain (preminting support)
  let domain = await context.subgraph_domains.get(node);
  if (!domain) {
    domain = {
      id: node,
      name: undefined,
      label_name: undefined,
      labelhash: labelHash,
      parent_id: managedNode,
      subdomain_count: 0,
      resolved_address_id: undefined,
      resolver_id: undefined,
      ttl: undefined,
      is_migrated: true,
      created_at: BigInt(event.block.timestamp),
      owner_id: owner,
      registrant_id: owner,
      wrapped_owner_id: undefined,
      expiry_date: expires + GRACE_PERIOD_SECONDS,
    };
    context.subgraph_domains.set(domain);
  }

  // Heal the label via ENSRainbow and interpret it (reference parity)
  const healedLabel = await context.effect(healLabelByLabelHash, labelHash);
  const label = IS_SUBGRAPH_COMPAT
    ? (isLabelSubgraphIndexable(healedLabel) ? healedLabel : undefined)
    : interpretHealedLabel(labelHash, healedLabel);

  domain = (await context.subgraph_domains.get(node))!;
  context.subgraph_domains.set({
    ...domain,
    registrant_id: owner,
    expiry_date: expires + GRACE_PERIOD_SECONDS,
    ...(label !== undefined ? { label_name: label, name: `${label}.${managedName}` } : {}),
  });

  const registrationId = makeRegistrationId(labelHash, node);
  await upsertRegistration(context, {
    id: registrationId,
    domain_id: node,
    registration_date: BigInt(event.block.timestamp),
    expiry_date: expires,
    registrant_id: owner,
    label_name: label,
  });

  context.subgraph_name_registered.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    registrant_id: owner,
    expiry_date: expires,
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
    block_number: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── BaseRegistrar_Linea.NameRenewed ────────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar_Linea", event: "NameRenewed" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.id);
  const expires = event.params.expires;

  const node = makeSubdomainNode(labelHash, managedNode);
  const registrationId = makeRegistrationId(labelHash, node);

  const registration = await context.subgraph_registrations.get(registrationId);
  if (registration) {
    context.subgraph_registrations.set({
      ...registration,
      expiry_date: expires,
    });
  }

  const domain = await context.subgraph_domains.get(node);
  if (domain) {
    context.subgraph_domains.set({
      ...domain,
      expiry_date: expires + GRACE_PERIOD_SECONDS,
    });
  }

  context.subgraph_name_renewed.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    expiry_date: expires,
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
    block_number: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── BaseRegistrar_Linea.Transfer ───────────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar_Linea", event: "Transfer" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.tokenId);
  const to = event.params.to;

  upsertAccount(context, to);

  const node = makeSubdomainNode(labelHash, managedNode);
  const registrationId = makeRegistrationId(labelHash, node);

  const registration = await context.subgraph_registrations.get(registrationId);
  if (!registration) return;

  context.subgraph_registrations.set({
    ...registration,
    registrant_id: to,
  });

  const domain = await context.subgraph_domains.get(node);
  if (domain) {
    context.subgraph_domains.set({
      ...domain,
      registrant_id: to,
    });
  }

  context.subgraph_name_transferred.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    new_owner_id: to,
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

// ─── EthController_Linea.NameRegistered (paid registration) ─────────────────
// Controller arg remapping: event.params.name = plaintext label,
// event.params.label = labelHash. Cost = baseCost + premium.

indexer.onEvent(
  { contract: "EthController_Linea", event: "NameRegistered" },
  async ({ event, context }) => {
  const label_name = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const baseCost = event.params.baseCost;
  const premium = event.params.premium;
  const cost = baseCost + premium;

  await setNamePreimage(context, label_name, labelHash, cost, managedNode, managedName);

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

// ─── EthController_Linea.NameRenewed ────────────────────────────────────────

indexer.onEvent(
  { contract: "EthController_Linea", event: "NameRenewed" },
  async ({ event, context }) => {
  const label_name = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, label_name, labelHash, cost, managedNode, managedName);

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

// ─── EthController_Linea.OwnerNameRegistered (free for controller owner) ────

indexer.onEvent(
  { contract: "EthController_Linea", event: "OwnerNameRegistered" },
  async ({ event, context }) => {
  const label_name = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, label_name, labelHash, 0n, managedNode, managedName);

  // Registrar: update action with pricing (free registration)
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: 0n,
    premium: 0n,
    total: 0n,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── EthController_Linea.PohNameRegistered (free for PoH holders) ───────────

indexer.onEvent(
  { contract: "EthController_Linea", event: "PohNameRegistered" },
  async ({ event, context }) => {
  const label_name = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, label_name, labelHash, 0n, managedNode, managedName);

  // Registrar: update action with pricing (free registration)
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: 0n,
    premium: 0n,
    total: 0n,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);
