import {
  BaseRegistrar_Base,
  EAController_Base,
  RegController_Base,
  UpgController_Base,
} from "generated";

import {
  BASE_ETH_NODE,
  GRACE_PERIOD_SECONDS,
  makeSubdomainNode,
  makeRegistrationId,
  upsertAccount,
  upsertRegistration,
  sharedEventValues,
  tokenIdToLabelHash,
  setNamePreimage,
  ZERO_ADDRESS,
} from "../lib/helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

const managedNode = BASE_ETH_NODE;
const managedName = "base.eth";

// ─── BaseRegistrar_Base.NameRegistered ──────────────────────────────────────

BaseRegistrar_Base.NameRegistered.handler(async ({ event, context }) => {
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

  context.NameRegisteredEvent.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    registrant_id: owner,
    expiryDate: expires,
  });
});

// ─── BaseRegistrar_Base.NameRegisteredWithRecord ────────────────────────────

BaseRegistrar_Base.NameRegisteredWithRecord.handler(
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

    context.NameRegisteredEvent.set({
      ...sharedEventValues(event.chainId, event),
      registration_id: registrationId,
      registrant_id: owner,
      expiryDate: expires,
    });
  },
);

// ─── BaseRegistrar_Base.NameRenewed ─────────────────────────────────────────

BaseRegistrar_Base.NameRenewed.handler(async ({ event, context }) => {
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

  context.NameRenewedEvent.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    expiryDate: expires,
  });
});

// ─── BaseRegistrar_Base.Transfer ────────────────────────────────────────────

BaseRegistrar_Base.Transfer.handler(async ({ event, context }) => {
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
});

// ─── EAController_Base.NameRegistered ───────────────────────────────────────
// Controller arg remapping: event.params.name = plaintext label,
// event.params.label = labelHash

EAController_Base.NameRegistered.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);
});

// ─── RegController_Base.NameRegistered ──────────────────────────────────────

RegController_Base.NameRegistered.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);
});

// ─── RegController_Base.NameRenewed ─────────────────────────────────────────

RegController_Base.NameRenewed.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);
});

// ─── UpgController_Base.NameRegistered ──────────────────────────────────────

UpgController_Base.NameRegistered.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);
});

// ─── UpgController_Base.NameRenewed ─────────────────────────────────────────

UpgController_Base.NameRenewed.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash

  await setNamePreimage(context, labelName, labelHash, 0n, managedNode, managedName);
});
