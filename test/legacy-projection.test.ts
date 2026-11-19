import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { keccak256, namehash, toBytes } from "viem";

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

describe("unlinking a registry retires the names projected through it (Sepolia)", () => {
  // upbit.eth is registered at 11,860,371 and links registry 0xf6eb6874 at
  // 11,876,722; main.upbit.eth is registered
  // there at 11,876,727; the link is removed at 11,884,602, so the name no longer has a
  // path (src/ensv2Domain.ts retireProjectedDomain on unlink).
  it("retires the row at the old node", async () => {
    const node = "0xe7963b82bbfbfa98ea1ecf7ba3cc7799ad4cc837cf9bcc0431585e6ff09393aa";
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 11155111: { startBlock: 11_860_371, endBlock: 11_860_371 } } });
    await indexer.process({ chains: { 11155111: { startBlock: 11_876_722, endBlock: 11_876_727 } } });
    const live = await indexer.Subgraph_domain.getOrThrow(node);
    expect(live.name).toBe("main.upbit.eth");
    expect(live.owner_id).not.toBe("0x0000000000000000000000000000000000000000");
    await indexer.process({ chains: { 11155111: { startBlock: 11_884_602, endBlock: 11_884_602 } } });
    const retired = await indexer.Subgraph_domain.getOrThrow(node);
    expect(retired.owner_id).toBe("0x0000000000000000000000000000000000000000");
    expect(retired.registrant_id).toBeUndefined();
    expect((await indexer.Legacy_projection.getOrThrow(`11155111-${node}`)).active).toBe(false);
  }, 300_000);
});

describe("ENSv2 resolver records in the legacy Resolver row", () => {
  // ens-subgraph 16846b1 src/ensv2ResolverProjection.ts: a live v2 name whose resolver is a
  // PermissionedResolver shows the linked record's addr, coin types, text keys and
  // contenthash on its legacy Resolver row, and the addr as Domain.resolvedAddress.
  it("snapshots the linked record when the name attaches the resolver (recallapp.eth, Ethereum)", async () => {
    // Resolver 0xaea93de6 links recallapp.eth and sets its ETH address at 26,356,729; the
    // name is registered on ENSv2 with that resolver at 26,356,735; the record's
    // contenthash is set at 26,356,751.
    const node = "0x769c5f27b94caaa153b857015cdc26ef77a2720dba182f9c74dffca397b0b550";
    const resolver = "0xaea93de6c4c91188b38a89bd5ff3c720ac9e8f72";
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 1: { startBlock: 26_356_729, endBlock: 26_356_735 } } });
    let domain = await indexer.Subgraph_domain.getOrThrow(node);
    expect(domain.resolver_id).toBe(`1-${resolver}-${node}`);
    let row = await indexer.Subgraph_resolver.getOrThrow(`1-${resolver}-${node}`);
    expect(row.addr_id).toBe("0x2db5dcc40c3cffe92e718513d62d9bcbb945a503");
    expect(row.coinTypes).toEqual([60n]);
    expect(row.contentHash).toBeUndefined();
    expect(domain.resolvedAddress_id).toBe("0x2db5dcc40c3cffe92e718513d62d9bcbb945a503");
    // A later record event refreshes the row.
    await indexer.process({ chains: { 1: { startBlock: 26_356_751, endBlock: 26_356_751 } } });
    row = await indexer.Subgraph_resolver.getOrThrow(`1-${resolver}-${node}`);
    expect(row.contentHash).toBe("0xe40101fa011b20e002e9ab0bee50f874a8ee461fe053aca71c7e3be502b941d8933008e357f9e0");
    domain = await indexer.Subgraph_domain.getOrThrow(node);
    expect(domain.resolvedAddress_id).toBe("0x2db5dcc40c3cffe92e718513d62d9bcbb945a503");
  }, 300_000);

  it("follows later record changes, keeps cleared keys and clears on unlink (simulated, Sepolia)", async () => {
    const CHAIN = 11155111;
    const ETH_REGISTRY = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4";
    const resolver = "0x5900000000000000000000000000000000000e06";
    const owner = "0x00000000000000000000000000000000000b0b03";
    const holder = "0x00000000000000000000000000000000000a11ce";
    const label = "snapshotted";
    const node = namehash(`${label}.eth`);
    const tokenId = BigInt(keccak256(toBytes(label)));
    const dns = "0x0b736e617073686f7474656403657468" + "00";
    const at = (n: number, logIndex: number) => ({ block: { number: n, timestamp: 1_790_000_000 + n }, logIndex });
    const indexer = createTestIndexer();
    const run = (items: any[]) => indexer.process({ chains: { [CHAIN]: { simulate: items } } });
    await run([
      { contract: "V2Registry", event: "LabelRegistered", srcAddress: ETH_REGISTRY, ...at(12_000_500, 1),
        params: { tokenId, labelHash: keccak256(toBytes(label)), label, owner, expiry: 9_999_999_999n, sender: owner } },
      { contract: "V2Registry", event: "ResolverUpdated", srcAddress: ETH_REGISTRY, ...at(12_000_500, 2), params: { tokenId, resolver, sender: owner } },
      { contract: "V2Resolver", event: "Linked", srcAddress: resolver, ...at(12_000_501, 1), params: { recordId: 1n, node, name: dns } },
      { contract: "V2Resolver", event: "AddressUpdated", srcAddress: resolver, ...at(12_000_501, 2), params: { recordId: 1n, coinType: 60n, addressBytes: holder } },
      { contract: "V2Resolver", event: "TextUpdated", srcAddress: resolver, ...at(12_000_501, 3), params: { recordId: 1n, keyHash: "avatar", key: "avatar", value: "x" } },
    ]);
    const id = `${CHAIN}-${resolver}-${node}`;
    let row = await indexer.Subgraph_resolver.getOrThrow(id);
    expect(row.addr_id).toBe(holder);
    expect(row.coinTypes).toEqual([60n]);
    expect(row.texts).toEqual(["avatar"]);
    expect((await indexer.Subgraph_domain.getOrThrow(node)).resolvedAddress_id).toBe(holder);
    // Clearing the address and the text keeps their keys, as the subgraph does.
    await run([
      { contract: "V2Resolver", event: "AddressUpdated", srcAddress: resolver, ...at(12_000_502, 1), params: { recordId: 1n, coinType: 60n, addressBytes: "0x" } },
      { contract: "V2Resolver", event: "TextUpdated", srcAddress: resolver, ...at(12_000_502, 2), params: { recordId: 1n, keyHash: "avatar", key: "avatar", value: "" } },
    ]);
    row = await indexer.Subgraph_resolver.getOrThrow(id);
    expect(row.addr_id).toBeUndefined();
    expect(row.coinTypes).toEqual([60n]);
    expect(row.texts).toEqual(["avatar"]);
    expect((await indexer.Subgraph_domain.getOrThrow(node)).resolvedAddress_id).toBeUndefined();
    // Linking the name to record 0 unlinks it: the snapshot is cleared.
    await run([
      { contract: "V2Resolver", event: "AddressUpdated", srcAddress: resolver, ...at(12_000_503, 1), params: { recordId: 1n, coinType: 60n, addressBytes: holder } },
      { contract: "V2Resolver", event: "Linked", srcAddress: resolver, ...at(12_000_503, 2), params: { recordId: 0n, node, name: dns } },
    ]);
    row = await indexer.Subgraph_resolver.getOrThrow(id);
    expect(row.addr_id).toBeUndefined();
    expect(row.coinTypes).toBeUndefined();
    expect(row.texts).toBeUndefined();
    expect((await indexer.Subgraph_domain.getOrThrow(node)).resolvedAddress_id).toBeUndefined();
  }, 120_000);
});
