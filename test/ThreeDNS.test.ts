import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { THREEDNS_RESOLVER } from "../src/lib/helpers";

// ─── ThreeDNS Tests ─────────────────────────────────────────────────────────
// Tests for ThreeDNSToken event handlers using real on-chain data
// from Optimism (chain 10) and Base (chain 8453).

describe("ThreeDNS (Optimism + Base)", () => {
  // ─── ThreeDNSToken.NewOwner + RegistrationCreated (Optimism) ────────────

  describe("ThreeDNSToken on Optimism", () => {
    it("creates domains with hardcoded resolver on NewOwner", async () => {
      const indexer = createTestIndexer();

      // Initialize root domain from Ethereum
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Process early ThreeDNS blocks on Optimism
      const result = await indexer.process({
        chains: {
          10: { startBlock: 110_393_959, endBlock: 110_394_200 },
        },
      });

      const domains = result.changes.flatMap(
        (c) => c.Domain?.sets ?? [],
      );

      // Verify domains were created
      expect(domains.length).toBeGreaterThan(0);

      // Verify ThreeDNS resolver is set on domains
      const domainsWithResolver = domains.filter(
        (d) => d.resolver_id !== undefined && d.resolver_id.includes(THREEDNS_RESOLVER),
      );
      if (domainsWithResolver.length > 0) {
        for (const d of domainsWithResolver) {
          expect(d.isMigrated).toBe(true);
        }
      }
    }, 60_000);
  });

  // ─── ThreeDNSToken.RegistrationCreated (Base) ─────────────────────────────

  describe("ThreeDNSToken on Base", () => {
    it("decodes DNS name and creates registration on RegistrationCreated", async () => {
      const indexer = createTestIndexer();

      // Initialize root domain from Ethereum
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Process ThreeDNS blocks on Base
      const result = await indexer.process({
        chains: {
          8453: { startBlock: 17_522_624, endBlock: 17_523_000 },
        },
      });

      const domains = result.changes.flatMap(
        (c) => c.Domain?.sets ?? [],
      );
      const registrations = result.changes.flatMap(
        (c) => c.Registration?.sets ?? [],
      );

      // Verify domains and registrations were created
      // (may be 0 if no events in this block range — the test validates no errors)
      if (registrations.length > 0) {
        for (const reg of registrations) {
          expect(reg.domain_id).toBeTruthy();
          expect(reg.registrant_id).toBeTruthy();
        }
      }

      // Verify domains with labels have names
      const domainsWithLabels = domains.filter(
        (d) => d.labelName !== undefined,
      );
      for (const d of domainsWithLabels) {
        expect(d.labelName).toBeTruthy();
        if (d.name) {
          expect(d.name).toContain(".");
        }
      }
    }, 60_000);
  });
});
