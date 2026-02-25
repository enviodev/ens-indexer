import {
  BaseRegistrar,
  LegacyController,
  WrappedController,
  UnwrappedController,
} from "generated";

import {
  ETH_NODE,
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

const managedNode = ETH_NODE;
const managedName = "eth";

// ─── BaseRegistrar Handlers ─────────────────────────────────────────────────

BaseRegistrar.NameRegistered.handler(async ({ event, context }) => {
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

  // Log NameRegisteredEvent
  context.NameRegisteredEvent.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    registrant_id: owner,
    expiryDate: expires,
  });
});

// ─── BaseRegistrar.NameRenewed ──────────────────────────────────────────────

BaseRegistrar.NameRenewed.handler(async ({ event, context }) => {
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

  // Log NameRenewedEvent
  context.NameRenewedEvent.set({
    ...sharedEventValues(event.chainId, event),
    registration_id: registrationId,
    expiryDate: expires,
  });
});

// ─── BaseRegistrar.Transfer ─────────────────────────────────────────────────

BaseRegistrar.Transfer.handler(async ({ event, context }) => {
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
});

// ─── LegacyController Handlers ─────────────────────────────────────────────

/**
 * LegacyController.NameRegistered provides the plaintext name.
 * event.params: { name: string (label), label: string (labelHash), owner, cost, expires }
 */
LegacyController.NameRegistered.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);
});

/**
 * LegacyController.NameRenewed provides the plaintext name on renewal.
 * event.params: { name: string (label), label: string (labelHash), cost, expires }
 */
LegacyController.NameRenewed.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);
});

// ─── WrappedController Handlers ─────────────────────────────────────────────

/**
 * WrappedController.NameRegistered provides the plaintext name.
 * event.params: { name, label (labelHash), owner, baseCost, premium, expires }
 * cost = baseCost + premium
 */
WrappedController.NameRegistered.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const cost = event.params.baseCost + event.params.premium;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);
});

/**
 * WrappedController.NameRenewed provides the plaintext name on renewal.
 * event.params: { name, label (labelHash), cost, expires }
 */
WrappedController.NameRenewed.handler(async ({ event, context }) => {
  const labelName = event.params.name; // plaintext label
  const labelHash = event.params.label; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);
});

// ─── UnwrappedController Handlers ───────────────────────────────────────────

/**
 * UnwrappedController.NameRegistered provides the plaintext name.
 * event.params: { label (plaintext), labelhash (bytes32), owner, baseCost, premium, expires, referrer }
 * cost = baseCost + premium
 */
UnwrappedController.NameRegistered.handler(async ({ event, context }) => {
  const labelName = event.params.label; // plaintext label
  const labelHash = event.params.labelhash; // bytes32 labelHash
  const cost = event.params.baseCost + event.params.premium;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);
});

/**
 * UnwrappedController.NameRenewed provides the plaintext name on renewal.
 * event.params: { label (plaintext), labelhash (bytes32), cost, expires, referrer }
 */
UnwrappedController.NameRenewed.handler(async ({ event, context }) => {
  const labelName = event.params.label; // plaintext label
  const labelHash = event.params.labelhash; // bytes32 labelHash
  const cost = event.params.cost;

  await setNamePreimage(context, labelName, labelHash, cost, managedNode, managedName);
});
