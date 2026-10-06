import { getAddress, pad, size, slice, zeroAddress } from "viem";
import type { handlerContext } from "./helpers";
import { makeSubdomainNode, makeEventId } from "./helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

const ENCODED_REFERRER_BYTE_OFFSET = 12;
const ENCODED_REFERRER_BYTE_LENGTH = 32;
const EXPECTED_PADDING: `0x${string}` = pad("0x", {
  size: ENCODED_REFERRER_BYTE_OFFSET,
  dir: "left",
});

// Metadata singleton ID
const METADATA_ID = "current";

// ─── ID Generators ──────────────────────────────────────────────────────────

/**
 * CAIP-10 subregistry ID: "eip155:{chainId}:{address}" (lowercase)
 */
export function makeSubregistryId(
  chainId: number,
  address: string,
): string {
  return `eip155:${chainId}:${address}`.toLowerCase();
}

/**
 * Logical event key: "{node}:{transactionHash}" (lowercase)
 */
export function makeLogicalEventKey(
  node: string,
  transactionHash: string,
): string {
  return `${node}:${transactionHash}`.toLowerCase();
}

// ─── Referrer Decoding ──────────────────────────────────────────────────────

/**
 * Decode a bytes32 encoded referrer to a checksummed address.
 * Left-zero-padded: first 12 bytes must be zeros, last 20 bytes are address.
 * Non-zero padding -> returns zero address.
 */
export function decodeEncodedReferrer(encodedReferrer: string): string {
  const hex = encodedReferrer as `0x${string}`;

  if (size(hex) !== ENCODED_REFERRER_BYTE_LENGTH) {
    throw new Error(
      `Encoded referrer value must be represented by ${ENCODED_REFERRER_BYTE_LENGTH} bytes.`,
    );
  }

  const padding = slice(hex, 0, ENCODED_REFERRER_BYTE_OFFSET);

  // strict validation: padding must be all zeros
  if (padding !== EXPECTED_PADDING) {
    return zeroAddress;
  }

  const decodedReferrer = slice(hex, ENCODED_REFERRER_BYTE_OFFSET);

  try {
    return getAddress(decodedReferrer).toLowerCase();
  } catch {
    throw new Error(`Decoded referrer value must be a valid EVM address.`);
  }
}

// ─── Subregistry Upsert ─────────────────────────────────────────────────────

/**
 * Idempotent subregistry upsert — always sets (overwrites or creates).
 */
export function upsertSubregistry(
  context: handlerContext,
  chainId: number,
  contractAddress: string,
  managedNode: string,
): void {
  const id = makeSubregistryId(chainId, contractAddress);
  context.Subregistry.set({
    id,
    node: managedNode,
  });
}

// ─── Registration Lifecycle Management ──────────────────────────────────────

/**
 * Get or create a RegistrationLifecycle for a given node.
 */
export async function getOrCreateRegistrationLifecycle(
  context: handlerContext,
  subregistryId: string,
  node: string,
  expiresAt: bigint,
): Promise<void> {
  const existing = await context.Registration_lifecycle.get(node);
  if (existing) {
    // Update expiresAt for re-registration after expiry
    context.Registration_lifecycle.set({
      ...existing,
      expiresAt,
    });
  } else {
    context.Registration_lifecycle.set({
      id: node,
      subregistryId,
      expiresAt,
    });
  }
}

/**
 * Update the expiresAt of an existing RegistrationLifecycle.
 */
export async function updateRegistrationLifecycleExpiry(
  context: handlerContext,
  node: string,
  expiresAt: bigint,
): Promise<void> {
  const existing = await context.Registration_lifecycle.get(node);
  if (existing) {
    context.Registration_lifecycle.set({
      ...existing,
      expiresAt,
    });
  }
}

// ─── Aggregates ─────────────────────────────────────────────────────────────

const SECONDS_PER_DAY = 86_400;

/**
 * Bump per-day and running totals for a subregistry. Called once when a
 * registrar action is recorded (count) and once when pricing arrives from the
 * controller event (cost), so each action contributes exactly once to each.
 */
export async function recordActionStats(
  context: handlerContext,
  params: {
    subregistryId: string;
    timestamp: number | bigint;
    type: "registration" | "renewal";
    count: boolean;
    cost: bigint;
  },
): Promise<void> {
  const day = Math.floor(Number(params.timestamp) / SECONDS_PER_DAY);
  const regs = params.count && params.type === "registration" ? 1 : 0;
  const renewals = params.count && params.type === "renewal" ? 1 : 0;

  const dailyId = `${params.subregistryId}:${day}`;
  const daily = await context.Registration_daily_stat.get(dailyId);
  context.Registration_daily_stat.set({
    id: dailyId,
    subregistryId: params.subregistryId,
    day,
    registrations: (daily?.registrations ?? 0) + regs,
    renewals: (daily?.renewals ?? 0) + renewals,
    totalCost: (daily?.totalCost ?? 0n) + params.cost,
  });

  const total = await context.Namespace_stat.get(params.subregistryId);
  context.Namespace_stat.set({
    id: params.subregistryId,
    registrations: (total?.registrations ?? 0) + regs,
    renewals: (total?.renewals ?? 0) + renewals,
    totalCost: (total?.totalCost ?? 0n) + params.cost,
  });
}

// ─── Referrer Stats ─────────────────────────────────────────────────────────

/**
 * Bump the referrer leaderboard once per action, when the action first gets a
 * non-zero decoded referrer.
 */
async function recordReferrerStat(
  context: handlerContext,
  params: {
    subregistryId: string;
    type: "registration" | "renewal";
    previousReferrer: string | undefined;
    referrer: string | undefined;
    cost: bigint;
  },
): Promise<void> {
  if (params.previousReferrer && params.previousReferrer !== zeroAddress) return;
  if (!params.referrer || params.referrer === zeroAddress) return;

  const id = `${params.subregistryId}:${params.referrer}`;
  const existing = await context.Referrer_stat.get(id);
  const regs = params.type === "registration" ? 1 : 0;
  const renewals = params.type === "renewal" ? 1 : 0;
  context.Referrer_stat.set({
    id,
    subregistryId: params.subregistryId,
    referrer: params.referrer,
    actions: (existing?.actions ?? 0) + 1,
    registrations: (existing?.registrations ?? 0) + regs,
    renewals: (existing?.renewals ?? 0) + renewals,
    totalCost: (existing?.totalCost ?? 0n) + params.cost,
  });
}

// ─── Registrar Action Creation ──────────────────────────────────────────────

/**
 * Insert a RegistrarAction and store metadata mapping for cross-event aggregation.
 */
export async function insertRegistrarAction(
  context: handlerContext,
  params: {
    id: string;
    type: "registration" | "renewal";
    subregistryId: string;
    node: string;
    incrementalDuration: bigint;
    registrant: string;
    blockNumber: number;
    timestamp: number;
    transactionHash: string;
    eventIds: string[];
  },
): Promise<void> {
  // Create logical event key
  const logicalEventKey = makeLogicalEventKey(params.node, params.transactionHash);

  // Store metadata singleton mapping
  context.Internal_registrar_action_metadata.set({
    id: METADATA_ID,
    logicalEventKey,
    logicalEventId: params.id,
  });

  // Store initial registrar action record
  context.Registrar_action.set({
    id: params.id,
    type: params.type,
    subregistryId: params.subregistryId,
    node: params.node,
    incremental_duration: params.incrementalDuration,
    baseCost: undefined,
    premium: undefined,
    total: undefined,
    registrant: params.registrant,
    owner: undefined,
    encodedReferrer: undefined,
    decodedReferrer: undefined,
    blockNumber: BigInt(params.blockNumber),
    timestamp: BigInt(params.timestamp),
    transactionHash: params.transactionHash,
    eventIds: params.eventIds,
  });

  await recordActionStats(context, {
    subregistryId: params.subregistryId,
    timestamp: params.timestamp,
    type: params.type,
    count: true,
    cost: 0n,
  });
}

// ─── Handler: BaseRegistrar Registration ────────────────────────────────────

/**
 * Called from BaseRegistrar NameRegistered handlers.
 * Creates subregistry, lifecycle, and initial registrar action.
 */
export async function handleRegistrarRegistration(
  context: handlerContext,
  params: {
    eventId: string;
    chainId: number;
    contractAddress: string;
    managedNode: string;
    labelHash: string;
    registrant: string;
    expiresAt: bigint;
    blockNumber: number;
    timestamp: number;
    transactionHash: string;
    /**
     * Node recorded on the subregistry when it differs from managedNode, e.g.
     * 3DNS where one contract manages many TLDs (pass ROOT_NODE).
     */
    subregistryNode?: string;
  },
): Promise<void> {
  const node = makeSubdomainNode(params.labelHash, params.managedNode);
  const subregistryId = makeSubregistryId(params.chainId, params.contractAddress);

  // Upsert subregistry
  upsertSubregistry(
    context,
    params.chainId,
    params.contractAddress,
    params.subregistryNode ?? params.managedNode,
  );

  // Get or create registration lifecycle
  await getOrCreateRegistrationLifecycle(context, subregistryId, node, params.expiresAt);

  // Calculate incremental duration (from block timestamp to expiry)
  const incrementalDuration = params.expiresAt - BigInt(params.timestamp);

  // Insert registrar action
  await insertRegistrarAction(context, {
    id: params.eventId,
    type: "registration",
    subregistryId,
    node,
    incrementalDuration,
    registrant: params.registrant,
    blockNumber: params.blockNumber,
    timestamp: params.timestamp,
    transactionHash: params.transactionHash,
    eventIds: [params.eventId],
  });
}

// ─── Handler: BaseRegistrar Renewal ─────────────────────────────────────────

/**
 * Called from BaseRegistrar NameRenewed handlers.
 * Creates renewal action and updates lifecycle expiry.
 */
export async function handleRegistrarRenewal(
  context: handlerContext,
  params: {
    eventId: string;
    chainId: number;
    contractAddress: string;
    managedNode: string;
    labelHash: string;
    registrant: string;
    expiresAt: bigint;
    blockNumber: number;
    timestamp: number;
    transactionHash: string;
  },
): Promise<void> {
  const node = makeSubdomainNode(params.labelHash, params.managedNode);
  const subregistryId = makeSubregistryId(params.chainId, params.contractAddress);

  // Get existing lifecycle to compute incremental duration. Missing means the
  // renewal predates the registration we've indexed (e.g. indexer started
  // mid-history); skip rather than crash the worker.
  const currentLifecycle = await context.Registration_lifecycle.get(node);
  if (!currentLifecycle) {
    context.log.warn(
      `Registrar renewal skipped: no RegistrationLifecycle for node '${node}'.`,
    );
    return;
  }

  // Calculate incremental duration (extension amount)
  const incrementalDuration = params.expiresAt - currentLifecycle.expiresAt;

  // Insert renewal registrar action
  await insertRegistrarAction(context, {
    id: params.eventId,
    type: "renewal",
    subregistryId,
    node,
    incrementalDuration,
    registrant: params.registrant,
    blockNumber: params.blockNumber,
    timestamp: params.timestamp,
    transactionHash: params.transactionHash,
    eventIds: [params.eventId],
  });

  // Update lifecycle expiry
  await updateRegistrationLifecycleExpiry(context, node, params.expiresAt);
}

// ─── Handler: Controller Event (pricing + referral) ─────────────────────────

/**
 * Called from Controller NameRegistered/NameRenewed handlers.
 * Updates existing registrar action with pricing and referral data.
 */
export async function handleRegistrarControllerEvent(
  context: handlerContext,
  params: {
    eventId: string;
    node: string;
    baseCost: bigint | undefined;
    premium: bigint | undefined;
    total: bigint | undefined;
    encodedReferrer: string | undefined;
    decodedReferrer: string | undefined;
    /** Owner from the controller's NameRegistered params; undefined for renewals. */
    owner?: string | undefined;
    transactionHash: string;
  },
): Promise<void> {
  const logicalEventKey = makeLogicalEventKey(params.node, params.transactionHash);

  // Read metadata singleton. Missing/mismatched means the paired BaseRegistrar
  // action was not indexed (e.g. indexer started mid-history); skip rather than
  // crash the worker.
  const metadata = await context.Internal_registrar_action_metadata.get(METADATA_ID);
  if (!metadata || metadata.logicalEventKey !== logicalEventKey) {
    context.log.warn(
      `Controller event skipped: no matching registrar action for key '${logicalEventKey}'.`,
    );
    return;
  }

  // Read existing registrar action
  const action = await context.Registrar_action.get(metadata.logicalEventId);
  if (!action) {
    context.log.warn(
      `Controller event skipped: registrar action '${metadata.logicalEventId}' not found.`,
    );
    return;
  }

  // Update with pricing, referral, and appended eventId
  context.Registrar_action.set({
    ...action,
    baseCost: params.baseCost,
    premium: params.premium,
    total: params.total,
    owner: params.owner ?? action.owner,
    encodedReferrer: params.encodedReferrer,
    decodedReferrer: params.decodedReferrer,
    eventIds: [...action.eventIds, params.eventId],
  });

  await recordReferrerStat(context, {
    subregistryId: action.subregistryId,
    type: action.type,
    previousReferrer: action.decodedReferrer,
    referrer: params.decodedReferrer,
    cost: params.total ?? 0n,
  });

  // Pricing is known only now. Count it once, on the first controller event
  // that carries a total for this action.
  if (action.total === undefined && params.total !== undefined) {
    await recordActionStats(context, {
      subregistryId: action.subregistryId,
      timestamp: action.timestamp,
      type: action.type,
      count: false,
      cost: params.total,
    });
  }
}

// ─── Handler: Universal Renewal Event (referral only) ───────────────────────

/**
 * Called from UniversalRegistrarRenewalWithReferrer RenewalReferred handler.
 * Updates existing registrar action with referral data only.
 */
export async function handleUniversalRenewalEvent(
  context: handlerContext,
  params: {
    eventId: string;
    node: string;
    encodedReferrer: string;
    decodedReferrer: string;
    transactionHash: string;
  },
): Promise<void> {
  const logicalEventKey = makeLogicalEventKey(params.node, params.transactionHash);

  // Read metadata singleton. Missing/mismatched means the paired BaseRegistrar
  // action was not indexed (e.g. indexer started mid-history); skip rather than
  // crash the worker.
  const metadata = await context.Internal_registrar_action_metadata.get(METADATA_ID);
  if (!metadata || metadata.logicalEventKey !== logicalEventKey) {
    context.log.warn(
      `Universal renewal skipped: no matching registrar action for key '${logicalEventKey}'.`,
    );
    return;
  }

  // Read existing registrar action
  const action = await context.Registrar_action.get(metadata.logicalEventId);
  if (!action) {
    context.log.warn(
      `Universal renewal skipped: registrar action '${metadata.logicalEventId}' not found.`,
    );
    return;
  }

  // Update with referral data and appended eventId
  context.Registrar_action.set({
    ...action,
    encodedReferrer: params.encodedReferrer,
    decodedReferrer: params.decodedReferrer,
    eventIds: [...action.eventIds, params.eventId],
  });
  await recordReferrerStat(context, {
    subregistryId: action.subregistryId,
    type: action.type,
    previousReferrer: action.decodedReferrer,
    referrer: params.decodedReferrer,
    cost: action.total ?? 0n,
  });
}
