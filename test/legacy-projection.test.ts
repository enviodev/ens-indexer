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
