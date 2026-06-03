import { indexer } from "envio";

import {
  BASE_ETH_NODE,
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

// ─── Constants ──────────────────────────────────────────────────────────────

const managedNode = BASE_ETH_NODE;
const managedName = "base.eth";

// ─── BaseRegistrar_Base.NameRegistered ──────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar_Base", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.id);
  const owner = event.params.owner;
  const expires = event.params.expires;

  upsertAccount(context, owner);

  const node = makeSubdomainNode(labelHash, managedNode);

  // Get or create the domain (preminting support)
  let domain = await context.Domain.get(node);
  if (!domain) {
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
    context.Domain.set({
      ...domain,
      registrant_id: owner,
      expiryDate: expires + GRACE_PERIOD_SECONDS,
    });
  }

  const registrationId = makeRegistrationId(labelHash, node);
  await upsertRegistration(context, {
    id: registrationId,
    domain_id: node,
    registrationDate: BigInt(event.block.timestamp),
    expiryDate: expires,
    registrant_id: owner,
  });

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

// ─── BaseRegistrar_Base.NameRegisteredWithRecord ────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar_Base", event: "NameRegisteredWithRecord" },
  async ({ event, context }) => {
    // Delegates to same logic as NameRegistered (extra resolver/ttl args
    // ignored per Ponder subgraph behavior)
    const labelHash = tokenIdToLabelHash(event.params.id);
    const owner = event.params.owner;
    const expires = event.params.expires;

    upsertAccount(context, owner);

    const node = makeSubdomainNode(labelHash, managedNode);

    let domain = await context.Domain.get(node);
    if (!domain) {
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
      context.Domain.set({
        ...domain,
        registrant_id: owner,
        expiryDate: expires + GRACE_PERIOD_SECONDS,
      });
    }

    const registrationId = makeRegistrationId(labelHash, node);
    await upsertRegistration(context, {
      id: registrationId,
      domain_id: node,
      registrationDate: BigInt(event.block.timestamp),
      expiryDate: expires,
      registrant_id: owner,
    });

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

// ─── BaseRegistrar_Base.NameRenewed ─────────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar_Base", event: "NameRenewed" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.id);
  const expires = event.params.expires;

  const node = makeSubdomainNode(labelHash, managedNode);
  const registrationId = makeRegistrationId(labelHash, node);

  const registration = await context.Registration.get(registrationId);
  if (registration) {
    context.Registration.set({
      ...registration,
      expiryDate: expires,
    });
  }

  const domain = await context.Domain.get(node);
  if (domain) {
    context.Domain.set({
      ...domain,
      expiryDate: expires + GRACE_PERIOD_SECONDS,
    });
  }

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

// ─── BaseRegistrar_Base.Transfer ────────────────────────────────────────────

indexer.onEvent(
  { contract: "BaseRegistrar_Base", event: "Transfer" },
  async ({ event, context }) => {
  const labelHash = tokenIdToLabelHash(event.params.tokenId);
  const to = event.params.to;

  upsertAccount(context, to);

  const node = makeSubdomainNode(labelHash, managedNode);
  const registrationId = makeRegistrationId(labelHash, node);

  const registration = await context.Registration.get(registrationId);
  if (!registration) return;

  context.Registration.set({
    ...registration,
    registrant_id: to,
  });

  const domain = await context.Domain.get(node);
  if (domain) {
    context.Domain.set({
      ...domain,
      registrant_id: to,
    });
  }

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

// ─── EAController_Base.NameRegistered ───────────────────────────────────────
// Controller arg remapping: event.params.name = plaintext label,
// event.params.label = labelHash

indexer.onEvent(
  { contract: "EAController_Base", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);

  // Registrar: update action with pricing (unknown for Basenames controllers)
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: undefined,
    premium: undefined,
    total: undefined,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── RegController_Base.NameRegistered ──────────────────────────────────────

indexer.onEvent(
  { contract: "RegController_Base", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);

  // Registrar: update action with pricing (unknown for Basenames controllers)
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: undefined,
    premium: undefined,
    total: undefined,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── RegController_Base.NameRenewed ─────────────────────────────────────────

indexer.onEvent(
  { contract: "RegController_Base", event: "NameRenewed" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);

  // Registrar: update action with pricing (unknown for Basenames controllers)
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: undefined,
    premium: undefined,
    total: undefined,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── UpgController_Base.NameRegistered ──────────────────────────────────────

indexer.onEvent(
  { contract: "UpgController_Base", event: "NameRegistered" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);

  // Registrar: update action with pricing (unknown for Basenames controllers)
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: undefined,
    premium: undefined,
    total: undefined,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);

// ─── UpgController_Base.NameRenewed ─────────────────────────────────────────

indexer.onEvent(
  { contract: "UpgController_Base", event: "NameRenewed" },
  async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);

  // Registrar: update action with pricing (unknown for Basenames controllers)
  const node = makeSubdomainNode(labelHash, managedNode);
  await handleRegistrarControllerEvent(context, {
    eventId: makeEventId(event.chainId, event.block.number, event.logIndex),
    node,
    baseCost: undefined,
    premium: undefined,
    total: undefined,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    transactionHash: event.transaction.hash,
  });
  },
);
