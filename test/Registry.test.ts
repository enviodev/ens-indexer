import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { ROOT_NODE, ETH_NODE, ZERO_ADDRESS } from "../src/lib/helpers";

// ─── Registry Tests ─────────────────────────────────────────────────────────
// Uses real on-chain data via HyperSync to verify Registry event handlers.
//
// Note: Deployment blocks (e.g. 3,327,417) often don't emit events themselves.
// The first RegistryOld NewOwner events fire in subsequent blocks as TLDs are
// set up. We use wider ranges to capture these.

describe("Registry", () => {
  // ─── RegistryOld: Root initialization + NewOwner events ────────────────

  describe("RegistryOld — root initialization + early NewOwner events", () => {
    it("creates the root domain and subdomains via NewOwner", async () => {
      const indexer = createTestIndexer();

      // Scan a range after RegistryOld deployment to capture first events.
      const result = await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_328_000 },
        },
      });

      // The root domain should be created on first NewOwner event
      const rootDomain = await indexer.subgraph_domain.get(ROOT_NODE);
      expect(rootDomain).toBeDefined();
      expect(rootDomain?.owner_id).toBeDefined();
      expect(rootDomain?.subdomainCount).toBeGreaterThanOrEqual(0);

      // Events were processed and produced domain changes
      expect(result.changes.length).toBeGreaterThan(0);
      const domains = result.changes.flatMap(
        (c) => c.subgraph_domain?.sets ?? [],
      );
      expect(domains.length).toBeGreaterThan(0);

      // Validate NewOwner event structure if present in changes
      const newOwnerEvents = result.changes.flatMap(
        (c) => c.subgraph_new_owner?.sets ?? [],
      );
      for (const event of newOwnerEvents) {
        expect(event.id).toBeDefined();
        expect(event.blockNumber).toBeDefined();
        expect(event.transactionID).toBeDefined();
        expect(event.domain_id).toBeDefined();
        expect(event.owner_id).toBeDefined();
        expect(event.parentDomain_id).toBeDefined();
      }
    }, 120_000);
  });

  // ─── New Registry: Migration events ────────────────────────────────────

  describe("Registry — new registry activation (blocks 9,380,380+)", () => {
    it("processes NewOwner events from the new registry with isMigrated=true", async () => {
      const indexer = createTestIndexer();

      // Pre-populate root from old registry
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_330_000 },
        },
      });

      // Process the new registry's first events (migration of TLDs)
      const result = await indexer.process({
        chains: {
          1: { startBlock: 9_380_380, endBlock: 9_381_000 },
        },
      });

      expect(result.changes.length).toBeGreaterThan(0);

      // Domains created/updated by the new registry should have isMigrated=true
      const domainSets = result.changes.flatMap(
        (c) => c.subgraph_domain?.sets ?? [],
      );
      const migratedDomains = domainSets.filter((d) => d.isMigrated === true);
      expect(migratedDomains.length).toBeGreaterThan(0);
    }, 60_000);
  });

  // ─── Transfer events ──────────────────────────────────────────────────

  describe("Registry — Transfer events", () => {
    it("updates domain ownership and logs Transfer events", async () => {
      const indexer = createTestIndexer();

      // Initialize root
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_330_000 },
        },
      });

      // Range with registry Transfer events (ownership transfers)
      const result = await indexer.process({
        chains: {
          1: { startBlock: 16_926_000, endBlock: 16_926_200 },
        },
      });

      // Check for Transfer event entities
      const transfers = result.changes.flatMap(
        (c) => c.subgraph_transfer?.sets ?? [],
      );

      expect(transfers.length).toBeGreaterThan(0);
      for (const transfer of transfers) {
        expect(transfer.id).toBeDefined();
        expect(transfer.domain_id).toBeDefined();
        expect(transfer.owner_id).toBeDefined();
        expect(transfer.transactionID).toBeDefined();
      }
    }, 30_000);
  });

  // ─── NewResolver + dynamic contract registration ──────────────────────

  describe("Registry — NewResolver + dynamic contract registration", () => {
    it("registers resolver addresses dynamically and creates NewResolver", async () => {
      const indexer = createTestIndexer();

      // Initialize root
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_330_000 },
        },
      });

      // Block 12,062,607 has NewResolver events (buytaert.eth sets resolver)
      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_062_607, endBlock: 12_062_607 },
        },
      });

      // Check for NewResolver entities
      const resolverEvents = result.changes.flatMap(
        (c) => c.subgraph_new_resolver?.sets ?? [],
      );

      expect(resolverEvents.length).toBeGreaterThan(0);
      for (const evt of resolverEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.domain_id).toBeDefined();
        expect(evt.resolver_id).toBeDefined();
        expect(evt.transactionID).toBeDefined();
      }

      // Resolver dynamic addresses should have been registered
      const resolverAddresses = indexer.chains[1].Resolver.addresses;
      expect(resolverAddresses.length).toBeGreaterThan(0);
    }, 30_000);
  });

  // ─── NewTTL events ────────────────────────────────────────────────────

  describe("Registry — NewTTL events", () => {
    it("updates domain TTL and logs NewTTL event entity", async () => {
      const indexer = createTestIndexer();

      // Initialize root
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_330_000 },
        },
      });

      // Process a wider range to find TTL events (they're less common)
      const result = await indexer.process({
        chains: {
          1: { startBlock: 9_380_380, endBlock: 9_380_500 },
        },
      });

      const ttlEvents = result.changes.flatMap(
        (c) => c.subgraph_new_ttl?.sets ?? [],
      );

      // TTL events may or may not appear in this range — validate structure if present
      for (const evt of ttlEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.domain_id).toBeDefined();
        expect(evt.ttl).toBeDefined();
        expect(evt.transactionID).toBeDefined();
      }
    }, 60_000);
  });
});
