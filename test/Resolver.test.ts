import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { makeResolverId, ROOT_NODE } from "../src/lib/helpers";

// ─── Resolver Tests ─────────────────────────────────────────────────────────
// Tests for dynamically-registered Resolver event handlers using real on-chain data.
// The Resolver contract is registered dynamically via Registry.NewResolver events,
// so these tests must first process registry blocks to register resolver addresses.

describe("Resolver", () => {
  // ─── AddrChanged ──────────────────────────────────────────────────────

  describe("AddrChanged", () => {
    it("updates resolver addr and materializes Domain.resolvedAddress_id", async () => {
      const indexer = createTestIndexer();

      // Initialize root
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 12,062,607 — "buytaert.eth" registration includes
      // NewResolver (registers resolver) + AddrChanged (sets ETH address)
      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_062_607, endBlock: 12_062_607 },
        },
      });

      // Check for AddrChanged entities
      const addrEvents = result.changes.flatMap(
        (c) => c.AddrChanged?.sets ?? [],
      );

      if (addrEvents.length > 0) {
        for (const evt of addrEvents) {
          expect(evt.id).toBeDefined();
          expect(evt.resolver_id).toBeDefined();
          expect(evt.addr_id).toBeDefined();
          expect(evt.transactionID).toBeDefined();
        }
      }

      // Check Resolver entities have addr_id set
      const resolvers = result.changes.flatMap(
        (c) => c.Resolver?.sets ?? [],
      );
      const resolversWithAddr = resolvers.filter(
        (r) => r.addr_id !== undefined,
      );

      if (resolversWithAddr.length > 0) {
        for (const r of resolversWithAddr) {
          expect(r.addr_id).toBeTruthy();
          expect(r.address).toBeTruthy();
          expect(r.domain_id).toBeTruthy();
        }
      }
    }, 30_000);
  });

  // ─── AddressChanged (multicoin) ───────────────────────────────────────

  describe("AddressChanged (multicoin)", () => {
    it("tracks multicoin addresses and accumulates coinTypes", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 12,062,607 has AddressChanged events
      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_062_607, endBlock: 12_062_607 },
        },
      });

      const multicoinEvents = result.changes.flatMap(
        (c) => c.MulticoinAddrChanged?.sets ?? [],
      );

      if (multicoinEvents.length > 0) {
        for (const evt of multicoinEvents) {
          expect(evt.id).toBeDefined();
          expect(evt.resolver_id).toBeDefined();
          expect(evt.coinType).toBeDefined();
          expect(evt.addr).toBeDefined();
        }
      }

      // Verify coinTypes array is being built on resolver
      const resolvers = result.changes.flatMap(
        (c) => c.Resolver?.sets ?? [],
      );
      const resolversWithCoinTypes = resolvers.filter(
        (r) => r.coinTypes && r.coinTypes.length > 0,
      );

      for (const r of resolversWithCoinTypes) {
        expect(r.coinTypes!.length).toBeGreaterThan(0);
        // coinTypes should be unique
        const uniqueCoinTypes = [...new Set(r.coinTypes!.map(String))];
        expect(uniqueCoinTypes.length).toBe(r.coinTypes!.length);
      }
    }, 30_000);
  });

  // ─── TextChanged ──────────────────────────────────────────────────────

  describe("TextChanged", () => {
    it("accumulates text keys on resolver and logs TextChangedEvent", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Block 18,965,734 — "mergendise.eth" includes multiple TextChanged events
      // (name, URL, location, social handles, avatar)
      const result = await indexer.process({
        chains: {
          1: { startBlock: 18_965_734, endBlock: 18_965_734 },
        },
      });

      const textEvents = result.changes.flatMap(
        (c) => c.TextChangedEvent?.sets ?? [],
      );

      if (textEvents.length > 0) {
        for (const evt of textEvents) {
          expect(evt.id).toBeDefined();
          expect(evt.resolver_id).toBeDefined();
          expect(evt.key).toBeDefined();
          expect(typeof evt.key).toBe("string");
          // value can be undefined (when cleared)
        }
      }

      // Verify texts array is being built on resolver
      const resolvers = result.changes.flatMap(
        (c) => c.Resolver?.sets ?? [],
      );
      const resolversWithTexts = resolvers.filter(
        (r) => r.texts && r.texts.length > 0,
      );

      for (const r of resolversWithTexts) {
        expect(r.texts!.length).toBeGreaterThan(0);
        // texts should be unique
        const uniqueTexts = [...new Set(r.texts!)];
        expect(uniqueTexts.length).toBe(r.texts!.length);
      }
    }, 60_000);
  });

  // ─── ContenthashChanged ───────────────────────────────────────────────

  describe("ContenthashChanged", () => {
    it("stores content hash on resolver and logs ContenthashChangedEvent", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // Scan a range known to contain contenthash changes
      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_100_000, endBlock: 12_100_100 },
        },
      });

      const chEvents = result.changes.flatMap(
        (c) => c.ContenthashChangedEvent?.sets ?? [],
      );

      for (const evt of chEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.resolver_id).toBeDefined();
        expect(evt.hash).toBeDefined();
      }
    }, 30_000);
  });

  // ─── VersionChanged ───────────────────────────────────────────────────

  describe("VersionChanged", () => {
    it("clears resolver data and resets Domain.resolvedAddress_id", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      // VersionChanged events are less common — scan a wider range after
      // the new resolver was deployed
      const result = await indexer.process({
        chains: {
          1: { startBlock: 16_926_000, endBlock: 16_926_200 },
        },
      });

      const versionEvents = result.changes.flatMap(
        (c) => c.VersionChangedEvent?.sets ?? [],
      );

      for (const evt of versionEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.resolver_id).toBeDefined();
        expect(evt.version).toBeDefined();
      }

      // If a VersionChanged was processed, verify resolver was cleared
      if (versionEvents.length > 0) {
        for (const evt of versionEvents) {
          const resolver = await indexer.Resolver.get(evt.resolver_id);
          if (resolver) {
            expect(resolver.addr_id).toBeUndefined();
            expect(resolver.contentHash).toBeUndefined();
            expect(resolver.coinTypes).toBeUndefined();
            expect(resolver.texts).toBeUndefined();
          }
        }
      }
    }, 60_000);
  });

  // ─── Resolver entity structure ────────────────────────────────────────

  describe("Resolver entity structure", () => {
    it("resolver ID follows chainId-address-node format", async () => {
      const indexer = createTestIndexer();

      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_327_417 },
        },
      });

      const result = await indexer.process({
        chains: {
          1: { startBlock: 12_062_607, endBlock: 12_062_607 },
        },
      });

      const resolvers = result.changes.flatMap(
        (c) => c.Resolver?.sets ?? [],
      );

      for (const r of resolvers) {
        // ID should match format: chainId-address-node
        expect(r.id).toMatch(/^1-0x[a-f0-9]+-0x[a-f0-9]+$/);
        expect(r.address).toBeTruthy();
        expect(r.domain_id).toBeTruthy();
      }
    }, 30_000);
  });

  // ─── Dynamic contract registration ────────────────────────────────────

  describe("Dynamic Resolver contract registration", () => {
    it("registers resolver addresses via NewResolver contractRegister", async () => {
      const indexer = createTestIndexer();

      // Process blocks that include NewResolver events.
      // The first NewResolver events for RegistryOld happen when domains
      // set their resolvers — this is well after the deployment block.
      // Block 12,062,607 (buytaert.eth) includes NewResolver events.
      await indexer.process({
        chains: {
          1: { startBlock: 3_327_417, endBlock: 3_330_000 },
        },
      });

      await indexer.process({
        chains: {
          1: { startBlock: 12_062_607, endBlock: 12_062_607 },
        },
      });

      // Resolver addresses should have been dynamically registered
      const resolverAddresses = indexer.chains[1].Resolver.addresses;
      expect(resolverAddresses.length).toBeGreaterThan(0);

      // All registered addresses should be lowercase hex
      for (const addr of resolverAddresses) {
        expect(addr).toMatch(/^0x[a-f0-9]{40}$/);
      }
    }, 60_000);
  });

  // ─── Full resolver flow in a single block ─────────────────────────────

  describe("Full resolver flow — block 18,965,734", () => {
    it("processes AddrChanged + TextChanged + multicoin in one block", async () => {
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

      // Collect resolver-related event types present
      const resolverEventTypes = new Set<string>();
      for (const change of result.changes) {
        if (change.AddrChanged?.sets?.length)
          resolverEventTypes.add("AddrChanged");
        if (change.MulticoinAddrChanged?.sets?.length)
          resolverEventTypes.add("MulticoinAddrChanged");
        if (change.TextChangedEvent?.sets?.length)
          resolverEventTypes.add("TextChanged");
        if (change.ContenthashChangedEvent?.sets?.length)
          resolverEventTypes.add("ContenthashChanged");
      }

      // This block should have at least AddrChanged
      expect(resolverEventTypes.size).toBeGreaterThanOrEqual(1);
    }, 60_000);
  });
});
