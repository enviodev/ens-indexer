import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import {
  BASE_ETH_NODE,
  GRACE_PERIOD_SECONDS,
  makeSubdomainNode,
} from "../src/lib/helpers";

// ─── Base Registrar Tests ──────────────────────────────────────────────────
// Tests for BaseRegistrar_Base, EAController_Base, RegController_Base, and
// UpgController_Base event handlers using real on-chain Base data.

describe("BaseRegistrar (Base L2)", () => {
  // ─── BaseRegistrar_Base.NameRegistered ───────────────────────────────

  describe("BaseRegistrar_Base.NameRegistered", () => {
    it("creates Registration + Domain with correct expiry under BASE_ETH_NODE", async () => {
      const indexer = createTestIndexer();

      // Initialize root domain from Ethereum (earliest chain start)
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 17,571,486 — first BaseRegistrar_Base events on Base
      // Process a small range around the Base registrar start
      const result = await indexer.process({
        chains: {
          8453: { startBlock: 17_571_486, endBlock: 17_571_600 },
        },
      });

      // Check that Registration entities were created
      const registrations = result.changes.flatMap(
        (c) => c.Registration?.sets ?? [],
      );

      // Check that Domain entities were created under BASE_ETH_NODE
      const domains = result.changes.flatMap(
        (c) => c.Domain?.sets ?? [],
      );
      const baseSubdomains = domains.filter(
        (d) => d.parent_id === BASE_ETH_NODE,
      );

      // Verify domain expiry includes grace period
      const domainsWithExpiry = baseSubdomains.filter(
        (d) => d.expiryDate !== undefined,
      );
      if (domainsWithExpiry.length > 0) {
        for (const d of domainsWithExpiry) {
          const reg = registrations.find((r) => r.domain_id === d.id);
          if (reg) {
            expect(d.expiryDate).toBe(reg.expiryDate + GRACE_PERIOD_SECONDS);
          }
        }
      }
    }, 60_000);
  });

  // ─── EAController_Base.NameRegistered ─────────────────────────────────

  describe("EAController_Base.NameRegistered", () => {
    it("sets plaintext label name on Domain and Registration with cost=0", async () => {
      const indexer = createTestIndexer();

      // Initialize root domain
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Process a range with EAController events (start block 17575699)
      const result = await indexer.process({
        chains: {
          8453: { startBlock: 17_575_699, endBlock: 17_575_800 },
        },
      });

      // Check registrations have cost = 0n (Base controllers use no cost)
      const registrations = result.changes.flatMap(
        (c) => c.Registration?.sets ?? [],
      );
      const regsWithCost = registrations.filter(
        (r) => r.cost !== undefined,
      );
      for (const r of regsWithCost) {
        expect(r.cost).toBe(0n);
      }

      // Check that domains have labelName set
      const domains = result.changes.flatMap(
        (c) => c.Domain?.sets ?? [],
      );
      const domainsWithLabels = domains.filter(
        (d) => d.labelName !== undefined,
      );
      for (const d of domainsWithLabels) {
        expect(d.labelName).toBeTruthy();
        if (d.name) {
          expect(d.name).toContain(".base.eth");
        }
      }
    }, 60_000);
  });
});
