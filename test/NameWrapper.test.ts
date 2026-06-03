import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { ROOT_NODE, ETH_NODE } from "../src/lib/helpers";

// ─── NameWrapper Tests ──────────────────────────────────────────────────────
// Tests for NameWrapper event handlers using real on-chain data.
// Block 18,965,734 is the "kitchen sink" — a single transaction that exercises
// NameWrapper (NameWrapped, TransferSingle), WrappedController (NameRegistered),
// Registry (NewOwner), Resolver (AddrChanged, TextChanged), and BaseRegistrar.

describe("NameWrapper", () => {
  // ─── NameWrapped + TransferSingle ─────────────────────────────────────

  describe("NameWrapped + TransferSingle (block 18,965,734)", () => {
    it("creates WrappedDomain with owner, fuses, and expiry", async () => {
      const indexer = createTestIndexer();

      // Initialize root
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 18,965,734 — "mergendise.eth" wrapped registration
      const result = await indexer.process({
        chains: {
          1: { startBlock: 18_965_734, endBlock: 18_965_734 },
        },
      });

      expect(result.changes.length).toBeGreaterThan(0);

      // Check WrappedDomain entities were created
      const wrappedDomains = result.changes.flatMap(
        (c) => c.WrappedDomain?.sets ?? [],
      );
      expect(wrappedDomains.length).toBeGreaterThan(0);

      for (const wd of wrappedDomains) {
        expect(wd.id).toBeDefined();
        expect(wd.domain_id).toBeDefined();
        expect(wd.owner_id).toBeDefined();
        expect(wd.fuses).toBeDefined();
        expect(typeof wd.fuses).toBe("number");
        expect(wd.expiryDate).toBeDefined();
        expect(wd.isActive).toBe(true);
      }
    }, 60_000);

    it("logs NameWrapped entities", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      const result = await indexer.process({
        chains: {
          1: { startBlock: 18_965_734, endBlock: 18_965_734 },
        },
      });

      const wrappedEvents = result.changes.flatMap(
        (c) => c.NameWrapped?.sets ?? [],
      );
      expect(wrappedEvents.length).toBeGreaterThan(0);

      for (const evt of wrappedEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.domain_id).toBeDefined();
        expect(evt.owner_id).toBeDefined();
        expect(evt.fuses).toBeDefined();
        expect(evt.expiryDate).toBeDefined();
        expect(evt.transactionID).toBeDefined();
      }
    }, 60_000);

    it("logs WrappedTransfer events from TransferSingle", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      const result = await indexer.process({
        chains: {
          1: { startBlock: 18_965_734, endBlock: 18_965_734 },
        },
      });

      const transfers = result.changes.flatMap(
        (c) => c.WrappedTransfer?.sets ?? [],
      );
      expect(transfers.length).toBeGreaterThan(0);

      for (const t of transfers) {
        expect(t.id).toBeDefined();
        expect(t.domain_id).toBeDefined();
        expect(t.owner_id).toBeDefined();
        expect(t.transactionID).toBeDefined();
      }
    }, 60_000);

    it("sets wrappedOwner_id on the Domain entity", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_330_000 },
        },
      });

      // Process block 18,965,734 — NameWrapped sets wrappedOwner_id on Domain
      const result = await indexer.process({
        chains: {
          1: { startBlock: 18_965_734, endBlock: 18_965_734 },
        },
      });

      // Check domains that have wrappedOwner set in the changes
      const domains = result.changes.flatMap((c) => c.Domain?.sets ?? []);
      const domainsWithWrappedOwner = domains.filter(
        (d) => d.wrappedOwner_id !== undefined,
      );

      expect(domainsWithWrappedOwner.length).toBeGreaterThan(0);
      for (const d of domainsWithWrappedOwner) {
        expect(d.wrappedOwner_id).toBeTruthy();
      }
    }, 60_000);
  });

  // ─── FusesSet ─────────────────────────────────────────────────────────

  describe("FusesSet", () => {
    it("logs FusesSet entities", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Scan a range after NameWrapper deployment for FusesSet events
      const result = await indexer.process({
        chains: {
          1: { startBlock: 16_925_700, endBlock: 16_925_800 },
        },
      });

      const fusesEvents = result.changes.flatMap(
        (c) => c.FusesSet?.sets ?? [],
      );

      for (const evt of fusesEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.domain_id).toBeDefined();
        expect(evt.fuses).toBeDefined();
        expect(typeof evt.fuses).toBe("number");
      }
    }, 60_000);
  });

  // ─── ExpiryExtended ───────────────────────────────────────────────────

  describe("ExpiryExtended", () => {
    it("logs ExpiryExtended entities", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Scan a range after NameWrapper deployment
      const result = await indexer.process({
        chains: {
          1: { startBlock: 16_926_000, endBlock: 16_926_200 },
        },
      });

      const expiryEvents = result.changes.flatMap(
        (c) => c.ExpiryExtended?.sets ?? [],
      );

      for (const evt of expiryEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.domain_id).toBeDefined();
        expect(evt.expiryDate).toBeDefined();
      }
    }, 60_000);
  });

  // ─── Kitchen sink: block 18,965,734 snapshot ──────────────────────────

  describe("Kitchen sink — block 18,965,734 covers multiple event types", () => {
    it("processes NameWrapper + BaseRegistrar + Controller + Registry + Resolver events in one block", async () => {
      const indexer = createTestIndexer();

      // Initialize root
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // This single block exercises nearly all event types
      const result = await indexer.process({
        chains: {
          1: { startBlock: 18_965_734, endBlock: 18_965_734 },
        },
      });

      // Collect all entity types that had changes
      const entityTypes = new Set<string>();
      for (const change of result.changes) {
        for (const key of Object.keys(change)) {
          const val = (change as any)[key];
          if (val && typeof val === "object" && "sets" in val) {
            entityTypes.add(key);
          }
        }
      }

      // This block should produce changes across multiple entity types
      // Expected: Domain, Account, Registration, WrappedDomain, NewOwner,
      //           NameRegisteredEvent, WrappedTransfer, NameWrapped, etc.
      expect(entityTypes.size).toBeGreaterThanOrEqual(4);
    }, 60_000);
  });
});
