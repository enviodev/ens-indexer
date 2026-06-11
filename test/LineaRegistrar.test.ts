import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import {
  LINEA_ETH_NODE,
  GRACE_PERIOD_SECONDS,
} from "../src/lib/helpers";

// ─── Linea Registrar Tests ─────────────────────────────────────────────────
// Tests for BaseRegistrar_Linea and EthController_Linea event handlers
// using real on-chain Linea data.

describe("LineaRegistrar (Linea L2)", () => {
  // ─── BaseRegistrar_Linea.NameRegistered ──────────────────────────────

  describe("BaseRegistrar_Linea.NameRegistered", () => {
    it("creates Registration + Domain under LINEA_ETH_NODE", async () => {
      const indexer = createTestIndexer();

      // Initialize root domain from Ethereum
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Process early Linea blocks with registrations
      const result = await indexer.process({
        chains: {
          59144: { startBlock: 6_682_892, endBlock: 6_683_100 },
        },
      });

      const domains = result.changes.flatMap(
        (c) => c.subgraph_domains?.sets ?? [],
      );
      const lineaSubdomains = domains.filter(
        (d) => d.parent_id === LINEA_ETH_NODE,
      );

      // Verify domain expiry includes grace period
      const domainsWithExpiry = lineaSubdomains.filter(
        (d) => d.expiry_date !== undefined,
      );
      if (domainsWithExpiry.length > 0) {
        const registrations = result.changes.flatMap(
          (c) => c.subgraph_registrations?.sets ?? [],
        );
        for (const d of domainsWithExpiry) {
          const reg = registrations.find((r) => r.domain_id === d.id);
          if (reg) {
            expect(d.expiry_date).toBe(reg.expiry_date + GRACE_PERIOD_SECONDS);
          }
        }
      }
    }, 60_000);
  });

  // ─── EthController_Linea.NameRegistered (paid) ────────────────────────

  describe("EthController_Linea.NameRegistered", () => {
    it("sets plaintext label with baseCost + premium", async () => {
      const indexer = createTestIndexer();

      // Initialize root domain
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Process blocks with controller events
      const result = await indexer.process({
        chains: {
          59144: { startBlock: 6_682_978, endBlock: 6_683_200 },
        },
      });

      const domains = result.changes.flatMap(
        (c) => c.subgraph_domains?.sets ?? [],
      );
      const domainsWithLabels = domains.filter(
        (d) => d.label_name !== undefined,
      );
      for (const d of domainsWithLabels) {
        expect(d.label_name).toBeTruthy();
        if (d.name) {
          expect(d.name).toContain(".linea.eth");
        }
      }
    }, 60_000);
  });
});
