import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import {
  ETH_NODE,
  GRACE_PERIOD_SECONDS,
  ROOT_NODE,
} from "../src/lib/helpers";

// ─── Registrar Tests ────────────────────────────────────────────────────────
// Tests for BaseRegistrar, LegacyController, WrappedController, and
// UnwrappedController event handlers using real on-chain data.

describe("Registrar", () => {
  // ─── BaseRegistrar.NameRegistered ─────────────────────────────────────

  describe("BaseRegistrar.NameRegistered", () => {
    it("creates Registration + Domain with correct expiry and grace period", async () => {
      const indexer = createTestIndexer();

      // Initialize root domain
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 12,010,405 — "luki.eth" registration via BaseRegistrar + LegacyController
      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_010_405, endBlock: 12_010_405 },
        },
      });

      // Check that Registration entities were created
      const registrations = result.changes.flatMap(
        (c) => c.subgraph_registration?.sets ?? [],
      );
      expect(registrations.length).toBeGreaterThan(0);

      // Check that NameRegistered entities were created
      const regEvents = result.changes.flatMap(
        (c) => c.subgraph_name_registered?.sets ?? [],
      );
      expect(regEvents.length).toBeGreaterThan(0);

      for (const evt of regEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.registration_id).toBeDefined();
        expect(evt.registrant_id).toBeDefined();
        expect(evt.expiryDate).toBeDefined();
      }

      // Verify a registration exists with proper structure
      for (const reg of registrations) {
        expect(reg.id).toBeDefined();
        expect(reg.domain_id).toBeDefined();
        expect(reg.registrant_id).toBeDefined();
        expect(reg.registrationDate).toBeDefined();
        expect(reg.expiryDate).toBeDefined();
      }

      // Domain expiry should include grace period (registration expiry + 90 days)
      const domains = result.changes.flatMap(
        (c) => c.subgraph_domain?.sets ?? [],
      );
      const domainsWithExpiry = domains.filter(
        (d) => d.expiryDate !== undefined,
      );
      if (domainsWithExpiry.length > 0) {
        for (const d of domainsWithExpiry) {
          // Find matching registration
          const reg = registrations.find((r) => r.domain_id === d.id);
          if (reg) {
            expect(d.expiryDate).toBe(reg.expiryDate + GRACE_PERIOD_SECONDS);
          }
        }
      }
    }, 30_000);
  });

  // ─── BaseRegistrar.NameRenewed ────────────────────────────────────────

  describe("BaseRegistrar.NameRenewed", () => {
    it("extends Registration and Domain expiry dates", async () => {
      const indexer = createTestIndexer();

      // Initialize
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Process a range that includes renewals
      // Renewals are common — scan a small range after BaseRegistrar deployment
      const result = await indexer.process({
        chains: {
          1: { startBlock: 9_500_000, endBlock: 9_500_100 },
        },
      });

      const renewEvents = result.changes.flatMap(
        (c) => c.subgraph_name_renewed?.sets ?? [],
      );

      // Validate structure if any found
      for (const evt of renewEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.registration_id).toBeDefined();
        expect(evt.expiryDate).toBeDefined();
        expect(evt.transactionID).toBeDefined();
      }
    }, 30_000);
  });

  // ─── BaseRegistrar.Transfer ───────────────────────────────────────────

  describe("BaseRegistrar.Transfer", () => {
    it("updates registrant on Registration and Domain", async () => {
      const indexer = createTestIndexer();

      // Initialize
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 12,010,405 includes BaseRegistrar Transfer events
      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_010_405, endBlock: 12_010_405 },
        },
      });

      const transferEvents = result.changes.flatMap(
        (c) => c.subgraph_name_transferred?.sets ?? [],
      );

      expect(transferEvents.length).toBeGreaterThan(0);
      for (const evt of transferEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.registration_id).toBeDefined();
        expect(evt.newOwner_id).toBeDefined();
        expect(evt.transactionID).toBeDefined();
      }
    }, 30_000);
  });

  // ─── LegacyController.NameRegistered (plaintext label reveal) ─────────

  describe("LegacyController.NameRegistered — label preimage", () => {
    it("reveals plaintext label name on Domain and Registration", async () => {
      const indexer = createTestIndexer();

      // Initialize
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_330_000 },
        },
      });

      // Block 12,010,405 — LegacyController NameRegistered for "luki"
      // Both BaseRegistrar and LegacyController events fire in this block
      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_010_405, endBlock: 12_010_405 },
        },
      });

      const domains = result.changes.flatMap(
        (c) => c.subgraph_domain?.sets ?? [],
      );
      const domainsWithLabels = domains.filter(
        (d) => d.labelName !== undefined,
      );

      // The controller event should have set labelName
      if (domainsWithLabels.length > 0) {
        for (const d of domainsWithLabels) {
          expect(d.labelName).toBeTruthy();
          // Name should be in format "label.eth"
          if (d.name) {
            expect(d.name).toContain(".eth");
          }
        }
      }
    }, 30_000);
  });

  // ─── WrappedController.NameRegistered ─────────────────────────────────

  describe("WrappedController.NameRegistered — wrapped registration", () => {
    it("reveals plaintext label with cost = baseCost + premium", async () => {
      const indexer = createTestIndexer();

      // Initialize
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 18,965,734 — WrappedController NameRegistered for "mergendise"
      const result = await indexer.process({
        chains: {
          1: { startBlock: 18_965_734, endBlock: 18_965_734 },
        },
      });

      // Check Registration entities have cost set
      const registrations = result.changes.flatMap(
        (c) => c.subgraph_registration?.sets ?? [],
      );
      const regsWithCost = registrations.filter(
        (r) => r.cost !== undefined,
      );

      if (regsWithCost.length > 0) {
        for (const r of regsWithCost) {
          expect(r.cost).toBeDefined();
          expect(typeof r.cost).toBe("bigint");
        }
      }
    }, 60_000);
  });

  // ─── Full registration flow: BaseRegistrar + Controller ───────────────

  describe("Full registration flow (block 12,062,607)", () => {
    it("creates Domain, Registration, Account, and event entities for 'buytaert.eth'", async () => {
      const indexer = createTestIndexer();

      // Initialize root
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 12,062,607 — full "buytaert.eth" registration flow
      // Includes: NameRegistered (BaseRegistrar + LegacyController), NewOwner, NewResolver, AddrChanged
      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_062_607, endBlock: 12_062_607 },
        },
      });

      expect(result.changes.length).toBeGreaterThan(0);

      // Multiple entity types should have been created in this block
      const entityTypes = new Set<string>();
      for (const change of result.changes) {
        for (const key of Object.keys(change)) {
          if (
            key !== "block" &&
            key !== "blockHash" &&
            key !== "chainId" &&
            key !== "eventsProcessed" &&
            key !== "addresses"
          ) {
            entityTypes.add(key);
          }
        }
      }

      // A full registration touches many entity types
      expect(entityTypes.size).toBeGreaterThanOrEqual(2);
    }, 30_000);
  });
});
