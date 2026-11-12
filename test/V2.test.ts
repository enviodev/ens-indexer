import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { decodeEventLog, keccak256, namehash, parseAbi, toBytes } from "viem";
import {
  makeV2DomainId,
  makeV2RegistryId,
  pickCanonicalEdge,
  propagateV2Registry,
  storageIdOf,
  type V2Domain,
  type V2Edge,
  type V2Registry,
} from "../src/lib/v2-helpers";
import { ETH_NODE, ZERO_ADDRESS } from "../src/lib/helpers";

// Every chain test indexes real Sepolia blocks. Fixtures are the raw logs of
// those blocks, decoded here with viem so expected values do not come from the
// indexer's own decoder.

const CHAIN = 11155111;
const ROOT_REGISTRY = "0xb458d6a3a77919449d03e7a6903c26827c1ec43f";
const ETH_REGISTRY = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4";
const BATCH_REGISTRAR = "0x4a4c8b7cdab6b19dc2cdb417cdb53a2ccbaf5322";
const UNLOCKED_MIGRATION = "0x2a35b94df22cc7354570be2284655e2cdc0e64a2";

const fixtures = JSON.parse(readFileSync("test/fixtures/v2-sepolia.json", "utf8"));

const ABI = parseAbi([
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
  "event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)",
  "event NameRegistered(uint256 indexed tokenId, string label, address owner, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 indexed referrer, uint256 base, uint256 premium)",
  "event NameRenewed(uint256 indexed tokenId, string label, uint64 duration, uint64 newExpiry, address paymentToken, bytes32 indexed referrer, uint256 amount)",
]);

const decode = (log: { data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] }) =>
  decodeEventLog({ abi: ABI, data: log.data, topics: log.topics }).args as Record<string, any>;
const blockOf = (log: { blockNumber: string }) => parseInt(log.blockNumber, 16);
const logIndexOf = (log: { logIndex: string }) => parseInt(log.logIndex, 16);
const process1 = (indexer: ReturnType<typeof createTestIndexer>, startBlock: number, endBlock: number) =>
  indexer.process({ chains: { [CHAIN]: { startBlock, endBlock } } });

// ─── Storage ids ─────────────────────────────────────────────────────────────

describe("storageIdOf", () => {
  it("clears exactly the 32 version bits", () => {
    expect(storageIdOf(0xdec08c9dbbdd0890e300eb5062089b2d4b1c40e3673bbccb5423f7b300000001n)).toBe(
      0xdec08c9dbbdd0890e300eb5062089b2d4b1c40e3673bbccb5423f7b300000000n,
    );
  });

  it("maps a tokenId and its labelhash to the same storage id", () => {
    const { topics } = fixtures.migrated;
    expect(storageIdOf(BigInt(topics[1]))).toBe(storageIdOf(BigInt(topics[2])));
  });
});

// ─── Provenance ──────────────────────────────────────────────────────────────

describe("provenance", () => {
  const child = "0xd00c33fe5123ba984226e12494c3e5c69ec486d8";
  const parent = "0xcba9a5bc4e04c810d1f7c49df5c1abd732efcded";

  it("discovers a registry from RegistryCreated but does not trust it", async () => {
    const indexer = createTestIndexer();
    await process1(indexer, 11825459, 11825459);
    const row = await indexer.V2_registry.getOrThrow(makeV2RegistryId(CHAIN, child));
    expect(row.proven).toBe(false);
    expect(row.name).toBeUndefined();
    expect(row.createdBlock).toBe(11825459);
    expect(indexer.chains[CHAIN].V2Registry.addresses).toContain(child);
  });

  it("does not trust a link from an unproven parent", async () => {
    const indexer = createTestIndexer();
    await process1(indexer, 11825459, 11825459);
    // The parent emitted the link in this block, but nothing proves the parent.
    const row = await indexer.V2_registry.getOrThrow(makeV2RegistryId(CHAIN, child));
    expect(row.proven).toBe(false);
    const edges = await indexer.V2_registry_edge.getWhere({ childRegistry_id: { _eq: row.id } });
    for (const e of edges) expect(e.active).toBe(true);
    const domains = await indexer.V2_domain.getWhere({ registry_id: { _eq: makeV2RegistryId(CHAIN, parent) } });
    for (const d of domains) expect(d.name).toBeUndefined();
  });

  it("watches a registry that never emitted RegistryCreated once a seed links it", async () => {
    const custom = "0xe1215ed4e1886d008a2b52c051d459031bf66363";
    const indexer = createTestIndexer();
    await process1(indexer, 11868901, 11868901);
    expect(indexer.chains[CHAIN].V2Registry.addresses).toContain(custom);
  });
});

// ─── Order independence ──────────────────────────────────────────────────────

describe("names do not depend on event order", () => {
  const child = "0xd00c33fe5123ba984226e12494c3e5c69ec486d8";
  const parent = "0xcba9a5bc4e04c810d1f7c49df5c1abd732efcded";

  it("names a child created, linked and written in one block (Sepolia 11857104)", async () => {
    // Log order in this block: child RegistryCreated@18, ETHRegistry link@34, child LabelRegistered@36.
    const child2 = "0x9f55213ff24f9eef0c03fd80de898ef0c2a397c5";
    const indexer = createTestIndexer();
    await process1(indexer, 11857104, 11857104);

    const registry = await indexer.V2_registry.getOrThrow(makeV2RegistryId(CHAIN, child2));
    expect(registry.proven).toBe(true);
    expect(registry.name?.split(".").length).toBe(2);
    expect(registry.name?.endsWith(".eth")).toBe(true);
    expect(registry.node).toBe(namehash(registry.name!));

    const labels = await indexer.V2_domain.getWhere({ registry_id: { _eq: registry.id } });
    expect(labels.length).toBeGreaterThan(0);
    for (const d of labels) {
      expect(d.name).toBe(`${d.label}.${registry.name}`);
      expect(d.node).toBe(namehash(d.name!));
    }
  });

  it("names labels written before their registry's first link, two levels deep in one block (mainnet 26,357,161)", async () => {
    // Log order in block 26,357,161: child 0xdd1d... writes labels at 110-128, its
    // parent 0x8490... links it at 154, and ETHRegistry links the parent at 156.
    // The parent's own .eth label was registered at block 26,357,113.
    const child = "0xdd1dece58eb7a5cebf8c1e0834b7ed4096e7ed20";
    const parentRegistry = "0x84909f7e499c85dc47f9e4f5f068fd83b5a7c843";
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 1: { startBlock: 26_357_113, endBlock: 26_357_161 } } });

    const parentRow = await indexer.V2_registry.getOrThrow(makeV2RegistryId(1, parentRegistry));
    expect(parentRow.proven).toBe(true);
    expect(parentRow.name?.endsWith(".eth")).toBe(true);
    const childRow = await indexer.V2_registry.getOrThrow(makeV2RegistryId(1, child));
    expect(childRow.proven).toBe(true);
    expect(childRow.name?.endsWith(`.${parentRow.name}`)).toBe(true);

    const labels = await indexer.V2_domain.getWhere({ registry_id: { _eq: childRow.id } });
    expect(labels.length).toBeGreaterThanOrEqual(5);
    for (const d of labels) {
      expect(d.name).toBe(`${d.label}.${childRow.name}`);
      expect(d.node).toBe(namehash(d.name!));
    }
  });

  it("leaves a chain unproven when it never reaches a seed (Sepolia 11825459)", async () => {
    // Real case: 0xcba9... claims a parent whose chain never links back to the root.
    const indexer = createTestIndexer();
    await process1(indexer, 11825459, 11825460);
    const parentRow = await indexer.V2_registry.getOrThrow(makeV2RegistryId(CHAIN, parent));
    expect(parentRow.proven).toBe(false);
    expect(parentRow.claimedLabel).toBe("croquis-app");
    expect(parentRow.claimMatchesLink).toBe(false);
    const childRow = await indexer.V2_registry.getOrThrow(makeV2RegistryId(CHAIN, child));
    expect(childRow.proven).toBe(false);
    expect(childRow.name).toBeUndefined();
  });

  it("names a label written before its registry was linked", () => {
    return runPropagation();
  });
});

// A small fake of the handler context, for propagation logic that is hard to
// reach with a single real block.
function fakeContext() {
  const tables: Record<string, Map<string, any>> = {
    V2_registry: new Map(), V2_domain: new Map(), V2_registry_edge: new Map(), V2_resolver: new Map(),
  };
  const ops = (name: string) => ({
    get: async (id: string) => tables[name]!.get(id),
    set: (row: any) => void tables[name]!.set(row.id, row),
    getWhere: async (filter: Record<string, { _eq: unknown }>) => {
      const [field, cond] = Object.entries(filter)[0]!;
      return [...tables[name]!.values()].filter((r) => r[field] === cond._eq);
    },
  });
  const context = {
    V2_registry: ops("V2_registry"),
    V2_domain: ops("V2_domain"),
    V2_registry_edge: ops("V2_registry_edge"),
    V2_resolver: ops("V2_resolver"),
    log: { warn: () => undefined },
  } as any;
  return { context, tables };
}

const registryRow = (address: string, over: Partial<V2Registry> = {}): V2Registry => ({
  id: makeV2RegistryId(1, address), chainId: 1, address, kind: "user", proven: false,
  node: undefined, name: undefined, parentDomain_id: undefined, claimedParent: undefined,
  claimedLabel: undefined, claimMatchesLink: undefined, createdBlock: 1, createdTimestamp: 0n, ...over,
} as V2Registry);

const domainRow = (registry: string, tokenId: bigint, label: string, over: Partial<V2Domain> = {}): V2Domain => ({
  id: makeV2DomainId(1, registry, tokenId), chainId: 1, registry_id: makeV2RegistryId(1, registry),
  storageId: "0x", tokenId, resource: undefined, labelhash: `0x${"ab".repeat(32)}`, label,
  node: undefined, name: undefined, status: "REGISTERED", owner: "0xowner", expiry: 9999999999n,
  subregistry: undefined, resolver: undefined, reservedBy: undefined, isPremigrated: false, isMigrated: false,
  migrationController: undefined, registrationCount: 1, createdBlock: 1, createdTimestamp: 0n,
  registeredTimestamp: 0n, updatedBlock: 1, ...over,
} as V2Domain);

async function runPropagation() {
  const { context, tables } = fakeContext();
  const seed = "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2"; // mainnet ETHRegistry
  const child = "0x00000000000000000000000000000000000000c1";
  const grandchild = "0x00000000000000000000000000000000000000c2";

  context.V2_registry.set(registryRow(seed, { kind: "eth", proven: true, node: ETH_NODE, name: "eth" }));
  context.V2_registry.set(registryRow(child));
  context.V2_registry.set(registryRow(grandchild));

  // Labels exist first: nobody has linked these registries yet.
  const parentDomain = domainRow(seed, 1n << 40n, "parent", {
    node: namehash("parent.eth"), name: "parent.eth", subregistry: child,
  });
  const inChild = domainRow(child, 2n << 40n, "sub", { subregistry: grandchild });
  const inGrandchild = domainRow(grandchild, 3n << 40n, "leaf");
  context.V2_domain.set(parentDomain);
  context.V2_domain.set(inChild);
  context.V2_domain.set(inGrandchild);

  const edge = (parentDomainId: string, childAddress: string): V2Edge => ({
    id: `${parentDomainId}-${childAddress}`, chainId: 1, parentDomain_id: parentDomainId,
    childRegistry_id: makeV2RegistryId(1, childAddress), active: true, linkedBlock: 5,
    linkedTimestamp: 0n, unlinkedBlock: undefined, sender: undefined,
  } as V2Edge);
  context.V2_registry_edge.set(edge(parentDomain.id, child));
  context.V2_registry_edge.set(edge(inChild.id, grandchild));

  await propagateV2Registry(context, 1, child);

  expect(tables.V2_registry!.get(makeV2RegistryId(1, child)).name).toBe("parent.eth");
  expect(tables.V2_domain!.get(inChild.id).name).toBe("sub.parent.eth");
  expect(tables.V2_registry!.get(makeV2RegistryId(1, grandchild)).name).toBe("sub.parent.eth");
  expect(tables.V2_domain!.get(inGrandchild.id).name).toBe("leaf.sub.parent.eth");

  // Removing the top link takes the whole subtree's names with it.
  context.V2_registry_edge.set({ ...tables.V2_registry_edge!.get(`${parentDomain.id}-${child}`), active: false });
  await propagateV2Registry(context, 1, child);
  expect(tables.V2_registry!.get(makeV2RegistryId(1, child)).proven).toBe(false);
  expect(tables.V2_domain!.get(inGrandchild.id).name).toBeUndefined();
}

describe("registry graph edge cases", () => {
  it("terminates on a registry that links to itself (seen on Sepolia, block 11918095)", async () => {
    const { context, tables } = fakeContext();
    const seed = "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2";
    const loop = "0xb36e0ede0ed38653c5ab8222b409a6b2ba78b409";
    context.V2_registry.set(registryRow(seed, { kind: "eth", proven: true, node: ETH_NODE, name: "eth" }));
    context.V2_registry.set(registryRow(loop));
    const top = domainRow(seed, 1n << 40n, "top", { node: namehash("top.eth"), name: "top.eth", subregistry: loop });
    const self = domainRow(loop, 2n << 40n, "self", { subregistry: loop });
    context.V2_domain.set(top);
    context.V2_domain.set(self);
    for (const parentId of [top.id, self.id]) {
      context.V2_registry_edge.set({
        id: `${parentId}-${loop}`, chainId: 1, parentDomain_id: parentId, childRegistry_id: makeV2RegistryId(1, loop),
        active: true, linkedBlock: parentId === top.id ? 5 : 6, linkedTimestamp: 0n, unlinkedBlock: undefined, sender: undefined,
      } as V2Edge);
    }
    await propagateV2Registry(context, 1, loop);
    expect(tables.V2_registry!.get(makeV2RegistryId(1, loop)).proven).toBe(true);
  });

  it("prefers the link a registry claims, but only among real links", () => {
    const registry = registryRow("0xc1", { claimedParent: "0xa2", claimedLabel: "two" });
    const mk = (addr: string, label: string, block: number) => ({
      edge: { id: addr, linkedBlock: block } as V2Edge,
      parentRegistry: registryRow(addr, { proven: true }),
      parentDomain: domainRow(addr, 1n << 40n, label),
    });
    const newest = mk("0xa1", "one", 9);
    const claimed = mk("0xa2", "two", 3);
    expect(pickCanonicalEdge(registry, [newest, claimed])?.parentRegistry.address).toBe("0xa2");
    const noClaimMatch = registryRow("0xc1", { claimedParent: "0xff", claimedLabel: "x" });
    expect(pickCanonicalEdge(noClaimMatch, [newest, claimed])?.parentRegistry.address).toBe("0xa1");
  });

  it("ignores links from unproven parents when picking a name", () => {
    const registry = registryRow("0xc1");
    const unproven = {
      edge: { id: "u", linkedBlock: 9 } as V2Edge,
      parentRegistry: registryRow("0xa1", { proven: false }),
      parentDomain: domainRow("0xa1", 1n << 40n, "x"),
    };
    expect(pickCanonicalEdge(registry, [unproven])).toBeUndefined();
  });
});

// ─── Token regeneration ──────────────────────────────────────────────────────

describe("TokenRegenerated", () => {
  const { regen, regenBlockLogs } = fixtures;

  it("keeps the domain on one row and maps both token ids to one resource", async () => {
    const indexer = createTestIndexer();
    await process1(indexer, 11820291, regen.block);
    const domainId = makeV2DomainId(CHAIN, ROOT_REGISTRY, BigInt(regen.old));
    const domain = await indexer.V2_domain.getOrThrow(domainId);
    expect(domain.tokenId).toBe(BigInt(regen.new));
    const registryId = makeV2RegistryId(CHAIN, ROOT_REGISTRY);
    const before = await indexer.V2_token_resource.getOrThrow(`${registryId}-${BigInt(regen.old)}`);
    const after = await indexer.V2_token_resource.getOrThrow(`${registryId}-${BigInt(regen.new)}`);
    expect(before.isCurrent).toBe(false);
    expect(after.isCurrent).toBe(true);
    expect(after.resource).toBe(before.resource);
    expect(after.regeneratedFrom).toBe(BigInt(regen.old));
  });

  it("reclassifies the burn and the mint, and keeps the owner", async () => {
    const indexer = createTestIndexer();
    await process1(indexer, 11820291, regen.block);
    const transfers = await indexer.V2_transfer.getWhere({ tokenId: { _in: [BigInt(regen.old), BigInt(regen.new)] } });
    const atBlock = transfers.filter((t: any) => t.blockNumber === regen.block);
    const burn = atBlock.find((t: any) => t.logIndex === regen.log - 1);
    const mint = atBlock.find((t: any) => t.logIndex === regen.log + 1);
    expect(burn?.kind).toBe("REGENERATION_BURN");
    expect(mint?.kind).toBe("REGENERATION_MINT");
    expect(regenBlockLogs.length).toBeGreaterThan(0);
    const domain = await indexer.V2_domain.getOrThrow(makeV2DomainId(CHAIN, ROOT_REGISTRY, BigInt(regen.old)));
    expect(domain.owner).toBe(mint?.to);
    expect(domain.owner).not.toBe(ZERO_ADDRESS);
  });
});

// ─── Premigration and migration ──────────────────────────────────────────────

describe("BatchRegistrar premigration", () => {
  it("records a reservation with the batch registrar as its source", async () => {
    const { reserved } = fixtures;
    const args = decode(reserved);
    const indexer = createTestIndexer();
    await process1(indexer, blockOf(reserved), blockOf(reserved));
    const domain = await indexer.V2_domain.getOrThrow(makeV2DomainId(CHAIN, ETH_REGISTRY, args.tokenId));
    expect(domain.status).toBe("RESERVED");
    expect(domain.owner).toBeUndefined();
    expect(domain.label).toBe(args.label);
    expect(domain.expiry).toBe(args.expiry);
    expect(domain.isPremigrated).toBe(true);
    expect(domain.reservedBy).toBe(BATCH_REGISTRAR);
    expect(domain.name).toBe(`${args.label}.eth`);
    expect(domain.node).toBe(namehash(`${args.label}.eth`));
  });
});

describe("v1 to v2 migration", () => {
  it("detects a migration from the controller that registered the name", async () => {
    const { migrated } = fixtures;
    const args = decode(migrated);
    const indexer = createTestIndexer();
    await process1(indexer, blockOf(migrated), blockOf(migrated));
    const domain = await indexer.V2_domain.getOrThrow(makeV2DomainId(CHAIN, ETH_REGISTRY, args.tokenId));
    expect(domain.isMigrated).toBe(true);
    expect(domain.migrationController).toBe(UNLOCKED_MIGRATION);
    expect(domain.status).toBe("REGISTERED");
    expect(domain.owner).toBe(args.owner.toLowerCase());
    const ledger = await indexer.V2_migration.getOrThrow(namehash(`${args.label}.eth`));
    expect(ledger.controller).toBe(UNLOCKED_MIGRATION);
  });
});

// ─── Cost fields ─────────────────────────────────────────────────────────────

describe("cost fields", () => {
  it("stores paymentToken, base and premium as emitted on NameRegistered", async () => {
    const { nameRegistered } = fixtures;
    const args = decode(nameRegistered);
    const indexer = createTestIndexer();
    await process1(indexer, blockOf(nameRegistered), blockOf(nameRegistered));
    const row = await indexer.V2_registration.getOrThrow(`${CHAIN}-${blockOf(nameRegistered)}-${logIndexOf(nameRegistered)}`);
    expect(row.paymentToken).toBe(args.paymentToken.toLowerCase());
    expect(row.base).toBe(args.base);
    expect(row.premium).toBe(args.premium);
    expect(row.duration).toBe(args.duration);
    expect(row.label).toBe(args.label);
  });

  it("stores a renewal's single amount", async () => {
    const { nameRenewed } = fixtures;
    const args = decode(nameRenewed);
    const indexer = createTestIndexer();
    await process1(indexer, blockOf(nameRenewed), blockOf(nameRenewed));
    const row = await indexer.V2_renewal.getOrThrow(`${CHAIN}-${blockOf(nameRenewed)}-${logIndexOf(nameRenewed)}`);
    expect(row.amount).toBe(args.amount);
    expect(row.newExpiry).toBe(args.newExpiry);
    expect(row.paymentToken).toBe(args.paymentToken.toLowerCase());
  });
});

// ─── Resolvers ───────────────────────────────────────────────────────────────

describe("resolver records", () => {
  it("treats two nodes on one record as aliases", async () => {
    const resolver = "0xd25d0a2cc153982ce2e097b2ae56e570f386b695";
    const [first, second] = fixtures.aliasLinks;
    const indexer = createTestIndexer();
    await process1(indexer, 11841670, blockOf(second));
    const resolverId = makeV2RegistryId(CHAIN, resolver);
    const a = await indexer.V2_record_link.getOrThrow(`${resolverId}-${first.topics[2]}`);
    const b = await indexer.V2_record_link.getOrThrow(`${resolverId}-${second.topics[2]}`);
    expect(a.record_id).toBe(b.record_id);
    expect(a.record_id).toBe(`${resolverId}-1`);
  });

  it("watches a resolver from creation, before any registry links it", async () => {
    const resolver = "0xd25d0a2cc153982ce2e097b2ae56e570f386b695";
    const indexer = createTestIndexer();
    await process1(indexer, 11841670, 11841670);
    const row = await indexer.V2_resolver.getOrThrow(makeV2RegistryId(CHAIN, resolver));
    expect(row.discoveredVia).toBe("ResolverCreated");
  });
});

// ─── Discovery order ─────────────────────────────────────────────────────────

describe("transfers on a registry nothing links to", () => {
  it("watches the registry from its first label (Sepolia 11820083)", async () => {
    // 0x657e... never emits RegistryCreated and is never a subregistry in this range.
    const registry = "0x657ea849311d3d5823348dded7c2aaafb3ede09e";
    const indexer = createTestIndexer();
    await process1(indexer, 11820083, 11820083);
    expect(indexer.chains[CHAIN].V2Registry.addresses).toContain(registry);
    const mint = await indexer.V2_transfer.getOrThrow(`${CHAIN}-11820083-194`);
    expect(mint.kind).toBe("MINT");
    const row = await indexer.V2_registry.getOrThrow(makeV2RegistryId(CHAIN, registry));
    expect(row.proven).toBe(false);
  });
});

describe("records written before the resolver is registered", () => {
  it("keeps records from blocks before discovery (Sepolia 11947405)", async () => {
    // Real case: resolver 0x7c48... wrote records at 11947405. With address-based
    // discovery it was first registered from 11951226, and these were lost.
    const resolver = "0x7c48b782cf9c132441844aeba8b46ec2d80ca067";
    const node = "0xbcd07235245d3cc5604d3e5451b3b88e61883fc266b3823f92429249285db373";
    const indexer = createTestIndexer();
    await process1(indexer, 11947405, 11947405);
    const resolverId = makeV2RegistryId(CHAIN, resolver);
    const link = await indexer.V2_record_link.getOrThrow(`${resolverId}-${node}`);
    expect(link.record_id).toBe(`${resolverId}-${BigInt(node)}`);
    const addresses = await indexer.V2_record_address.getWhere({ record_id: { _eq: link.record_id } });
    expect(addresses.length).toBe(2);
    const texts = await indexer.V2_record_text.getWhere({ record_id: { _eq: link.record_id } });
    expect(texts.length).toBe(1);
  });
});

// ─── Provenance gate ─────────────────────────────────────────────────────────
// Wildcard handlers see these signatures from any contract. These tests drive a
// contract that emits every one of them but is never linked from a seed.

const SPOOF = "0x5900000000000000000000000000000000000f00";
const SPOOF_CHILD = "0x5900000000000000000000000000000000000c01";
const SPOOF_RESOLVER = "0x5900000000000000000000000000000000000e02";
const ATTACKER = "0x00000000000000000000000000000000000a77ac";
const labelId = (label: string) => BigInt(keccak256(toBytes(label)));

function spoofEvents(block: number) {
  const vitalik = labelId("vitalik");
  const ethTokenId = labelId("eth");
  const head = { block: { number: block, timestamp: 1_790_000_000 } };
  return [
    { contract: "V2RegistryDiscovery", event: "RegistryCreated", srcAddress: SPOOF, ...head },
    { contract: "V2Registry", event: "LabelRegistered", srcAddress: SPOOF, ...head,
      params: { tokenId: vitalik, labelHash: keccak256(toBytes("vitalik")), label: "vitalik", owner: ATTACKER, expiry: 9_999_999_999n, sender: ATTACKER } },
    { contract: "V2Registry", event: "SubregistryUpdated", srcAddress: SPOOF, ...head, params: { tokenId: vitalik, subregistry: SPOOF_CHILD, sender: ATTACKER } },
    { contract: "V2Registry", event: "ResolverUpdated", srcAddress: SPOOF, ...head, params: { tokenId: vitalik, resolver: SPOOF_RESOLVER, sender: ATTACKER } },
    // Claim to be the parent of the real .eth registry, and to be "eth" itself.
    { contract: "V2Registry", event: "LabelRegistered", srcAddress: SPOOF, ...head,
      params: { tokenId: ethTokenId, labelHash: keccak256(toBytes("eth")), label: "eth", owner: ATTACKER, expiry: 9_999_999_999n, sender: ATTACKER } },
    { contract: "V2Registry", event: "SubregistryUpdated", srcAddress: SPOOF, ...head, params: { tokenId: ethTokenId, subregistry: ETH_REGISTRY, sender: ATTACKER } },
    { contract: "V2Registry", event: "ParentUpdated", srcAddress: SPOOF, ...head, params: { parent: ETH_REGISTRY, label: "vitalik", sender: ATTACKER } },
    { contract: "V2Registry", event: "LabelRegistered", srcAddress: SPOOF_CHILD, ...head,
      params: { tokenId: labelId("wallet"), labelHash: keccak256(toBytes("wallet")), label: "wallet", owner: ATTACKER, expiry: 9_999_999_999n, sender: ATTACKER } },
    { contract: "V2Resolver", event: "Linked", srcAddress: SPOOF_RESOLVER, ...head, params: { recordId: 1n, node: namehash("vitalik.eth"), name: "0x0776697461 6c696b0365746800".replace(/ /g, "") } },
    { contract: "V2Resolver", event: "AddressUpdated", srcAddress: SPOOF_RESOLVER, ...head, params: { recordId: 1n, coinType: 60n, addressBytes: ATTACKER } },
  ] as any[];
}

describe("provenance gate", () => {
  it("gives a never-linked contract no names, even when it mimics the .eth tree", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: spoofEvents(12_000_000) } } });

    for (const address of [SPOOF, SPOOF_CHILD]) {
      const row = await indexer.V2_registry.getOrThrow(makeV2RegistryId(CHAIN, address));
      expect(row.proven).toBe(false);
      expect(row.name).toBeUndefined();
      const domains = await indexer.V2_domain.getWhere({ registry_id: { _eq: row.id } });
      expect(domains.length).toBeGreaterThan(0);
      for (const d of domains) {
        expect(d.name).toBeUndefined();
        expect(d.node).toBeUndefined();
      }
    }
    // The spoof's link to the real .eth registry does not rename or re-prove it.
    const eth = await indexer.V2_registry.get(makeV2RegistryId(CHAIN, ETH_REGISTRY));
    if (eth) {
      expect(eth.name).toBe("eth");
      expect(eth.parentDomain_id).toBeUndefined();
    }
    const resolver = await indexer.V2_resolver.getOrThrow(makeV2RegistryId(CHAIN, SPOOF_RESOLVER));
    expect(resolver.proven).toBe(false);
    // Nothing named "vitalik.eth" exists.
    const named = await indexer.V2_domain.getWhere({ name: { _eq: "vitalik.eth" } });
    expect(named).toHaveLength(0);
  });

  it("applies a contract's earlier events once a seed links it, in their original order", async () => {
    const LATE = "0x5900000000000000000000000000000000000a7e";
    const parentLabel = "latecomer";
    const parentToken = labelId(parentLabel);
    const childToken = labelId("first");
    const regenerated = (childToken & ~0xffffffffn) | 1n;
    const at = (n: number) => ({ block: { number: n, timestamp: 1_790_000_000 + n } });
    const NEW_OWNER = "0x00000000000000000000000000000000000b0b01";
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            // Activity on the unlinked registry, in order: register, regenerate, transfer.
            { contract: "V2Registry", event: "LabelRegistered", srcAddress: LATE, ...at(12_000_100),
              params: { tokenId: childToken, labelHash: keccak256(toBytes("first")), label: "first", owner: ATTACKER, expiry: 9_999_999_999n, sender: ATTACKER } },
            { contract: "V2Registry", event: "TokenRegenerated", srcAddress: LATE, ...at(12_000_101), params: { oldTokenId: childToken, newTokenId: regenerated } },
            { contract: "V2Registry", event: "TransferSingle", srcAddress: LATE, ...at(12_000_102),
              params: { operator: ATTACKER, from: ATTACKER, to: NEW_OWNER, id: regenerated, value: 1n } },
            // The proof arrives later: the real .eth registry links it.
            { contract: "V2Registry", event: "LabelRegistered", srcAddress: ETH_REGISTRY, ...at(12_000_200),
              params: { tokenId: parentToken, labelHash: keccak256(toBytes(parentLabel)), label: parentLabel, owner: ATTACKER, expiry: 9_999_999_999n, sender: ATTACKER } },
            { contract: "V2Registry", event: "SubregistryUpdated", srcAddress: ETH_REGISTRY, ...at(12_000_200), params: { tokenId: parentToken, subregistry: LATE, sender: ATTACKER } },
          ] as any[],
        },
      },
    });
    const registry = await indexer.V2_registry.getOrThrow(makeV2RegistryId(CHAIN, LATE));
    expect(registry.proven).toBe(true);
    expect(registry.name).toBe("latecomer.eth");
    const domain = await indexer.V2_domain.getOrThrow(makeV2DomainId(CHAIN, LATE, childToken));
    expect(domain.name).toBe("first.latecomer.eth");
    expect(domain.node).toBe(namehash("first.latecomer.eth"));
    expect(domain.tokenId).toBe(regenerated);
    expect(domain.owner).toBe(NEW_OWNER);
  });
});

// ─── Late registration on real blocks ───────────────────────────────────────
// On Sepolia, HyperIndex 3.16 registered these contracts from a later block than
// their first event, and kept that start block. Each window is the real range
// between the first event and the late start block.

describe("events before late registration (Sepolia, all affected addresses)", () => {
  const cases = (JSON.parse(readFileSync("test/fixtures/v2-late-discovery.json", "utf8")) as any[])
    .filter((c) => c.logsBeforeRegistration > 0);

  it.each(cases.map((c) => [c.address, c]))("indexes the gap for %s", async (_address, c: any) => {
    const indexer = createTestIndexer();
    await process1(indexer, c.firstLogBlock, c.registeredFrom - 1);
    const id = makeV2RegistryId(CHAIN, c.address);
    if (c.kind === "registry") {
      const row = await indexer.V2_registry.getOrThrow(id);
      expect(row.createdBlock).toBe(c.firstLogBlock);
      return;
    }
    const resolver = await indexer.V2_resolver.get(id);
    const links = await indexer.V2_record_link.getWhere({ resolver_id: { _eq: id } });
    const nodeTexts = await indexer.V2_node_text.getWhere({ resolver: { _eq: c.address } });
    const nodeAddrs = await indexer.V2_node_address.getWhere({ resolver: { _eq: c.address } });
    if (c.distinctLinkedNodes > 0) expect(links.length).toBe(c.distinctLinkedNodes);
    else if (c.hasRecords || nodeTexts.length + nodeAddrs.length > 0) expect(nodeTexts.length + nodeAddrs.length).toBeGreaterThan(0);
    else expect(resolver?.createdBlock).toBe(c.firstLogBlock);
  });
});

// ─── Chain scope ─────────────────────────────────────────────────────────────

describe("wildcard handlers stay on their chains", () => {
  it("writes no ENSv2 rows for resolver events on Base (block 17,600,946)", async () => {
    // HyperIndex applies a wildcard handler on every chain; without the chain
    // filter this AddrChanged on Base was copied into v2_node_address.
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 8453: { startBlock: 17_600_946, endBlock: 17_600_946 } } });
    expect(await indexer.V2_node_address.getAll()).toHaveLength(0);
    expect(await indexer.V2_node_record.getAll()).toHaveLength(0);
  });
});

// ─── Change log for the stream ───────────────────────────────────────────────

describe("name_event", () => {
  it("logs reservations with name and node (Sepolia 11821357)", async () => {
    const { reserved } = fixtures;
    const args = decode(reserved);
    const indexer = createTestIndexer();
    await process1(indexer, blockOf(reserved), blockOf(reserved));
    const row = await indexer.Name_event.getOrThrow(`${CHAIN}-${blockOf(reserved)}-${logIndexOf(reserved)}`);
    expect(row.kind).toBe("RESERVATION");
    expect(row.protocol).toBe("v2");
    expect(row.name).toBe(`${args.label}.eth`);
    expect(row.node).toBe(namehash(`${args.label}.eth`));
  });

  it("logs a record change once per name that shares the record (Sepolia 11947405)", async () => {
    const indexer = createTestIndexer();
    await process1(indexer, 11947405, 11947405);
    const events = await indexer.Name_event.getWhere({ blockNumber: { _eq: 11947405 } });
    const kinds = new Set(events.map((e: any) => e.kind));
    expect(kinds.has("ALIAS")).toBe(true);
    expect(kinds.has("RECORD")).toBe(true);
    for (const e of events.filter((x: any) => x.kind === "RECORD")) {
      expect(e.node).toBe("0xbcd07235245d3cc5604d3e5451b3b88e61883fc266b3823f92429249285db373");
    }
  });

  it("numbers a fanned-out record change by link id, whatever the lookup order (Sepolia 11997481)", async () => {
    // Record 1 of resolver 0x72d374ff is linked to five names. Before the sort,
    // which name got which event id depended on lookup order and changed between runs.
    const resolver = "0x72d374ff9f8600cd386e1fd4c853564836de45b1";
    const nodes = [
      "0xd63d1843e52b40220c960ac3ef80808280e827eff31199ef1d1e50d908e0260b",
      "0x992291aceefbb945c0228d5796a050c56f851f2dec8d3026b93b158ac710b78c",
      "0x710678729b0ce0b85a0203e3466c76ad001b0676d6e7bfe750a047eef43f6a97",
      "0x2181159815208d30061797fffc862132ceada36df1780de77780c12d55f540cd",
      "0x1a93e5a3133fe2125f58ce80c5c1baa2e4c9dd0049f9f64e84b1b20d98c22e08",
    ];
    const indexer = createTestIndexer();
    for (const node of nodes) {
      indexer.V2_record_link.set({
        id: `${CHAIN}-${resolver}-${node}`, chainId: CHAIN, resolver_id: `${CHAIN}-${resolver}`,
        record_id: `${CHAIN}-${resolver}-1`, node, name: undefined, active: true, updatedBlock: 11997000,
      } as any);
    }
    await process1(indexer, 11997481, 11997481);
    const events = (await indexer.Name_event.getWhere({ blockNumber: { _eq: 11997481 } }))
      .filter((e: any) => e.kind === "RECORD" && e.logIndex === 321)
      .sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
    expect(events.map((e: any) => e.node)).toEqual([...nodes].sort());
  });

  it("logs a primary-name change from the standalone reverse registrar (Base 32,443,718)", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 8453: { startBlock: 32_443_718, endBlock: 32_443_718 } } });
    const row = await indexer.Name_event.getOrThrow("8453-32443718-120");
    expect(row.kind).toBe("PRIMARY_NAME");
    expect(row.address).toBe("0x179a862703a4adfb29896552df9e307980d19285");
    expect(JSON.parse(row.detail!).coinType).toBe(2147492101);
  });
});

// ─── Access control ──────────────────────────────────────────────────────────

describe("EACRolesChanged", () => {
  it("records the role bitmap per contract, resource and account", async () => {
    const { regen, regenBlockLogs } = fixtures;
    const eac = regenBlockLogs.find((l: any) => l.topics[0].startsWith("0x0d35bf72"));
    const indexer = createTestIndexer();
    await process1(indexer, 11820291, regen.block);
    const resource = BigInt(eac.topics[1]);
    const account = `0x${eac.topics[2].slice(26)}`;
    const row = await indexer.V2_permission.getOrThrow(`${CHAIN}-${ROOT_REGISTRY}-${resource}-${account}`);
    expect(row.roles).toBe(BigInt(`0x${eac.data.slice(66, 130)}`));
  });
});
