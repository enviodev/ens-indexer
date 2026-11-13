import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

// ENSv2 projection into the legacy subgraph_* tables, as the ENS subgraph does it
// (ens-subgraph 16846b1 src/ensv2Domain.ts, src/legacyGovernance.ts). Real mainnet blocks.

const process1 = (indexer: ReturnType<typeof createTestIndexer>, block: number) =>
  indexer.process({ chains: { 1: { startBlock: block, endBlock: block } } });

describe("a live ENSv2 name owns its legacy row", () => {
  // fairdata.eth: registered natively on ENSv2 at 26,286,908. At 26,303,889 a
  // Graveyard.clear() of its retired v1 record emits NewOwner(Graveyard) and
  // NewResolver(0x0) on the v1 registry.
  const node = "0x96b8f769ceeef765434ceac36769b2a5b3c0b9d6f89d8cdaaf2db2e0f8f416e8";

  it("takes holder, expiry and resolver from v2, and later v1 events do not overwrite them", async () => {
    const indexer = createTestIndexer();
    await process1(indexer, 26_286_908);
    const v2 = (await indexer.V2_domain.getWhere({ node: { _eq: node } }))[0]!;
    expect(v2.status).toBe("REGISTERED");
    const check = async () => {
      const legacy = await indexer.Subgraph_domain.getOrThrow(node);
      expect(legacy.owner_id).toBe(v2.owner);
      expect(legacy.registrant_id).toBe(v2.owner);
      expect(legacy.expiryDate).toBe(v2.expiry! + 2_419_200n); // .eth: v2 expiry plus the 28-day v2 grace period
      expect(legacy.resolver_id).toBe(v2.resolver ? `1-${v2.resolver}-${node}` : undefined);
      expect(legacy.isMigrated).toBe(true);
      expect(legacy.wrappedOwner_id).toBeUndefined();
      const registration = await indexer.Subgraph_registration.getOrThrow(node);
      expect(registration.registrant_id).toBe(v2.owner);
      expect(registration.expiryDate).toBe(v2.expiry);
    };
    await check();
    expect(v2.resolver).toBeDefined();
    await process1(indexer, 26_303_889);
    await check();
    // The v1 events are still recorded.
    const newResolver = (await indexer.Subgraph_new_resolver.getAll()).filter((e: any) => e.domain_id === node);
    expect(newResolver.length).toBeGreaterThan(0);
  }, 180_000);
});

describe("legacy expiry clamp for a never-expiring ENSv2 name", () => {
  // blumen-test.stauro.eth: stauro.eth registers and links a subregistry, which then
  // registers blumen-test with expiry 2^64 - 1, all in block 26,282,937.
  it("writes 253402300799 to the legacy row and keeps the raw value in v2_domain", async () => {
    const node = "0x016fcd5f379df3577c1934aecdcd423e05d0cce30bd33f8a602e29126139665f";
    const indexer = createTestIndexer();
    await process1(indexer, 26_282_937);
    const v2 = (await indexer.V2_domain.getWhere({ node: { _eq: node } }))[0]!;
    expect(v2.expiry).toBe(18446744073709551615n);
    const legacy = await indexer.Subgraph_domain.getOrThrow(node);
    expect(legacy.name).toBe("blumen-test.stauro.eth");
    expect(legacy.owner_id).toBe(v2.owner);
    expect(legacy.expiryDate).toBe(253402300799n);
  }, 180_000);
});

describe("a v2-only name gets a legacy row", () => {
  // blumen-test.stauro.eth never existed in ENSv1: no v1 event ever names its node.
  // The projection creates its subgraph_domain row under stauro.eth (26,282,937).
  it("creates the row with name, label, parent and holder", async () => {
    const node = "0x016fcd5f379df3577c1934aecdcd423e05d0cce30bd33f8a602e29126139665f";
    const indexer = createTestIndexer();
    await process1(indexer, 26_282_937);
    const v2 = (await indexer.V2_domain.getWhere({ node: { _eq: node } }))[0]!;
    const legacy = await indexer.Subgraph_domain.getOrThrow(node);
    const parentNode = (await indexer.V2_registry.getOrThrow(v2.registry_id)).node!;
    expect(legacy.labelName).toBe("blumen-test");
    expect(legacy.labelhash).toBe(v2.labelhash);
    expect(legacy.parent_id).toBe(parentNode);
    expect(legacy.owner_id).toBe(v2.owner);
    expect(legacy.registrant_id).toBe(v2.owner);
    expect(legacy.isMigrated).toBe(true);
    expect(await indexer.Subgraph_new_owner.getAll().then((rows: any[]) => rows.some((r) => r.domain_id === node))).toBe(false);
  }, 180_000);
});

describe("unregistering a v2 name retires its legacy row", () => {
  // guezito.eth links subregistry 0xffc84b3a at 26,285,227; taproot.guezito.eth is
  // registered there by 26,285,324 and unregistered at 26,285,329.
  it("applies the ENSv1 deletion convention and leaves the parent's count", async () => {
    const node = "0x130cdc8f227f19e601b1ff9ecb40fef7471012998efe9d3e06843db7a976816d";
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 1: { startBlock: 26_285_227, endBlock: 26_285_324 } } });
    const live = await indexer.Subgraph_domain.getOrThrow(node);
    expect(live.owner_id).not.toBe("0x0000000000000000000000000000000000000000");
    const parentBefore = await indexer.Subgraph_domain.getOrThrow(live.parent_id!);
    await indexer.process({ chains: { 1: { startBlock: 26_285_325, endBlock: 26_285_329 } } });
    const retired = await indexer.Subgraph_domain.getOrThrow(node);
    expect(retired.owner_id).toBe("0x0000000000000000000000000000000000000000");
    expect(retired.registrant_id).toBeUndefined();
    expect(retired.resolver_id).toBeUndefined();
    expect(retired.expiryDate).toBeLessThan(live.expiryDate!);
    const parentAfter = await indexer.Subgraph_domain.getOrThrow(live.parent_id!);
    expect(parentAfter.subdomainCount).toBe(parentBefore.subdomainCount - 1);
    expect((await indexer.Legacy_projection.getOrThrow(`1-${node}`)).active).toBe(false);
  }, 300_000);
});
