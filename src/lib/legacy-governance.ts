// ENSv2-era rules for the legacy (subgraph-shaped) tables, as the ENS subgraph applies
// them (ensdomains/ens-subgraph 16846b1: src/legacyGovernance.ts, src/ensv2Constants.ts,
// src/ensRegistry.ts, src/ethRegistrar.ts, src/nameWrapper.ts).
//
// A sink is a contract ENSv1 state is handed to when a name is retired or migrated: the
// Graveyard, the GraveyardRepairer and the migration controllers. None of them ever
// controls a name, so the legacy holder fields (subgraph_domain owner, registrant,
// wrappedOwner; subgraph_registration registrant; subgraph_wrapped_domain owner) never
// hold one. ENSv1 events that hand a name to a sink only write their event rows.

import { isMigrationController } from "./v2-deployments";

const GRAVEYARDS: Record<number, readonly string[]> = {
  1: ["0xda021a2c1c2f99574d861ef8c6fa745851beb7f6"],
  11155111: ["0xb58a90a39d13cce1d0e192b5da5c47640855b04d"],
};

// GraveyardRepairer: not deployed on any network yet (contracts-v2, 2026-11-11).
const GRAVEYARD_REPAIRERS: Record<number, readonly string[]> = {};

const has = (list: Record<number, readonly string[]>, chainId: number, address: string) =>
  list[chainId]?.includes(address.toLowerCase()) ?? false;

/** A registration to one of these is a retirement of an expired name, not a registration. */
export function isRetirementRegistrant(chainId: number, address: string): boolean {
  return has(GRAVEYARDS, chainId, address) || has(GRAVEYARD_REPAIRERS, chainId, address);
}

// Migration controllers: the full list from the contracts-v2 deployments, including
// controllers superseded on 2026-10-18 (the subgraph lists only the two current ones;
// any controller that received v1 state is a sink).
export function isSink(chainId: number, address: string): boolean {
  return isRetirementRegistrant(chainId, address) || isMigrationController(chainId, address);
}
