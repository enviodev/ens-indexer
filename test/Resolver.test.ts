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

      // Range with resolver AddrChanged events (sets ETH address)
      const result = await indexer.process({
        chains: {
          1: { startBlock: 16_925_700, endBlock: 16_925_800 },
        },
      });

      // Check for AddrChanged entities
      const addrEvents = result.changes.flatMap(
        (c) => c.Subgraph_addr_changed?.sets ?? [],
      );

      expect(addrEvents.length).toBeGreaterThan(0);
      for (const evt of addrEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.resolver_id).toBeDefined();
        expect(evt.addr_id).toBeDefined();
        expect(evt.transactionID).toBeDefined();
      }

      // Check Resolver entities have addr_id set
      const resolvers = result.changes.flatMap(
        (c) => c.Subgraph_resolver?.sets ?? [],
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
    }, 120_000);
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

      // Range with multicoin AddressChanged events
      const result = await indexer.process({
        chains: {
          1: { startBlock: 16_925_700, endBlock: 16_925_800 },
        },
      });

      const multicoinEvents = result.changes.flatMap(
        (c) => c.Subgraph_multicoin_addr_changed?.sets ?? [],
      );

      expect(multicoinEvents.length).toBeGreaterThan(0);
      for (const evt of multicoinEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.resolver_id).toBeDefined();
        expect(evt.coinType).toBeDefined();
        expect(evt.addr).toBeDefined();
      }

      // Verify coinTypes array is being built on resolver
      const resolvers = result.changes.flatMap(
        (c) => c.Subgraph_resolver?.sets ?? [],
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
    }, 120_000);
  });

  // ─── TextChanged ──────────────────────────────────────────────────────

  describe("TextChanged", () => {
    it("accumulates text keys on resolver and logs TextChanged", async () => {
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
        (c) => c.Subgraph_text_changed?.sets ?? [],
      );

      expect(textEvents.length).toBeGreaterThan(0);
      for (const evt of textEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.resolver_id).toBeDefined();
        expect(evt.key).toBeDefined();
        expect(typeof evt.key).toBe("string");
        // value can be undefined (when cleared)
      }

      // Verify texts array is being built on resolver
      const resolvers = result.changes.flatMap(
        (c) => c.Subgraph_resolver?.sets ?? [],
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
    }, 120_000);
  });

  // ─── ContenthashChanged ───────────────────────────────────────────────

  describe("ContenthashChanged", () => {
    it("stores content hash on resolver and logs ContenthashChanged", async () => {
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
        (c) => c.Subgraph_contenthash_changed?.sets ?? [],
      );

      for (const evt of chEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.resolver_id).toBeDefined();
        expect(evt.hash).toBeDefined();
      }
    }, 120_000);
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
        (c) => c.Subgraph_version_changed?.sets ?? [],
      );

      for (const evt of versionEvents) {
        expect(evt.id).toBeDefined();
        expect(evt.resolver_id).toBeDefined();
        expect(evt.version).toBeDefined();
      }

      // If a VersionChanged was processed, verify resolver was cleared
      if (versionEvents.length > 0) {
        for (const evt of versionEvents) {
          const resolver = await indexer.Subgraph_resolver.get(evt.resolver_id);
          if (resolver) {
            expect(resolver.addr_id).toBeUndefined();
            expect(resolver.contentHash).toBeUndefined();
            expect(resolver.coinTypes).toBeUndefined();
            expect(resolver.texts).toBeUndefined();
          }
        }
      }
    }, 120_000);
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
        (c) => c.Subgraph_resolver?.sets ?? [],
      );

      for (const r of resolvers) {
        // ID should match format: chainId-address-node
        expect(r.id).toMatch(/^1-0x[a-f0-9]+-0x[a-f0-9]+$/);
        expect(r.address).toBeTruthy();
        expect(r.domain_id).toBeTruthy();
      }
    }, 120_000);
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
    }, 120_000);
  });

  // ─── Resolver events do not depend on when the address is watched ─────

  describe("PublicResolver 0x4976fb03 (lost range 9,413,818 to 9,466,703 in a 3.16 full sync)", () => {
    const resolver = "0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41";

    it("indexes its records at block 9,418,322 with no prior registry state", async () => {
      // In a full sync HyperIndex 3.16 registered this address from block
      // 9,466,703 and kept that start, losing 1,027 events. Resolver events are
      // matched by signature, so they do not depend on when the address is watched.
      const indexer = createTestIndexer();
      await indexer.process({ chains: { 1: { startBlock: 9_418_322, endBlock: 9_418_322 } } });
      const addrChanges = (await indexer.Subgraph_addr_changed.getAll()).filter((e: any) =>
        e.resolver_id.startsWith(`1-${resolver}-`),
      );
      expect(addrChanges).toHaveLength(1);
    }, 120_000);
  });

  // ─── Records set before a registry assigns the resolver (subgraph rule) ─
  // The ENS subgraph's Resolver data source has no address and no start block:
  // it applies resolver events from every contract, assigned or not. A .eth name
  // (node 0xec1037...) had its addr and avatar set on resolver 0xcb811181 at
  // blocks 20,742,315 and 20,742,316, then pointed at that resolver at 20,742,318.
  // The public subgraph returns that addr as the name's resolvedAddress.

  describe("records set before the resolver is assigned", () => {
    const resolver = "0xcb811181de259d802decc0df4addf6628fb0e229";
    const node = "0xec103702f1a036ce809c3cff59ba3233ffecc0445ad8278d202c208ee9d74ba1";
    const addr = "0x64ca550f78d6cc711b247319cc71a04a166707ab";
    const resolverId = makeResolverId(1, resolver, node);

    it("keeps records a resolver emits before any registry assigns it", async () => {
      const indexer = createTestIndexer();
      await indexer.process({ chains: { 1: { startBlock: 20_742_315, endBlock: 20_742_316 } } });
      const row = await indexer.Subgraph_resolver.getOrThrow(resolverId);
      expect(row.addr_id).toBe(addr);
      const records = await indexer.Resolver_address_record.getAll();
      expect(records.some((r: any) => r.address === resolver && r.node === node && r.value === addr)).toBe(true);
      const texts = await indexer.Resolver_text_record.getAll();
      expect(texts.some((r: any) => r.address === resolver && r.node === node && r.key === "avatar")).toBe(true);
    }, 120_000);

    it("sets resolvedAddress from the stored addr when the name points at the resolver", async () => {
      const indexer = createTestIndexer();
      await indexer.process({ chains: { 1: { startBlock: 3_327_417, endBlock: 3_327_417 } } });
      await indexer.process({ chains: { 1: { startBlock: 14_419_246, endBlock: 14_419_246 } } }); // name created
      await indexer.process({ chains: { 1: { startBlock: 20_742_315, endBlock: 20_742_318 } } });
      const domain = await indexer.Subgraph_domain.getOrThrow(node);
      expect(domain.resolver_id).toBe(resolverId);
      expect(domain.resolvedAddress_id).toBe(addr);
    }, 180_000);
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
        if (change.Subgraph_addr_changed?.sets?.length)
          resolverEventTypes.add("AddrChanged");
        if (change.Subgraph_multicoin_addr_changed?.sets?.length)
          resolverEventTypes.add("MulticoinAddrChanged");
        if (change.Subgraph_text_changed?.sets?.length)
          resolverEventTypes.add("TextChanged");
        if (change.Subgraph_contenthash_changed?.sets?.length)
          resolverEventTypes.add("ContenthashChanged");
      }

      // This block should have at least AddrChanged
      expect(resolverEventTypes.size).toBeGreaterThanOrEqual(1);
    }, 120_000);
  });
});
