import { describe, it, expect } from "vitest";
import {
  makeSubdomainNode,
  makeResolverId,
  makeEventId,
  makeRegistrationId,
  encodeLabelHash,
  bigintMax,
  uniq,
  hasNullByte,
  stripNullBytes,
  isIndexable,
  isInterpretableLabel,
  namehashFromLabels,
  emptyToUndefined,
  indexableOrUndefined,
  MAX_INDEXED_STRING_BYTES,
  sharedEventValues,
  setDomain,
  syncParentSubdomainCountOnEmptinessChange,
  namespaceForNewDomain,
  tokenIdToLabelHash,
  decodeDnsEncodedName,
  ROOT_NODE,
  ETH_NODE,
  BASE_ETH_NODE,
  LINEA_ETH_NODE,
  ADDR_REVERSE_NODE,
  ZERO_ADDRESS,
  GRACE_PERIOD_SECONDS,
  THREEDNS_RESOLVER,
} from "../src/lib/helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

describe("Constants", () => {
  it("ROOT_NODE is 32 zero bytes", () => {
    expect(ROOT_NODE).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("ETH_NODE is the namehash of 'eth'", () => {
    // keccak256(abi.encodePacked(bytes32(0), keccak256("eth")))
    expect(ETH_NODE).toBe(
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
    );
  });

  it("ADDR_REVERSE_NODE is correct", () => {
    expect(ADDR_REVERSE_NODE).toBe(
      "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2",
    );
  });

  it("ZERO_ADDRESS is 40 hex zeros", () => {
    expect(ZERO_ADDRESS).toBe("0x0000000000000000000000000000000000000000");
  });

  it("GRACE_PERIOD_SECONDS is 90 days", () => {
    expect(GRACE_PERIOD_SECONDS).toBe(7_776_000n);
    expect(GRACE_PERIOD_SECONDS).toBe(BigInt(90 * 24 * 60 * 60));
  });

  it("BASE_ETH_NODE is the namehash of 'base.eth'", () => {
    expect(BASE_ETH_NODE).toBe(
      "0xff1e3c0eb00ec714e34b6114125fbde1dea2f24a72fbf672e7b7fd5690328e10",
    );
    // Verify it can be derived from ETH_NODE + keccak256("base")
    const { keccak256, encodePacked } = require("viem");
    const baseLabelHash = keccak256(encodePacked(["string"], ["base"]));
    const computed = makeSubdomainNode(baseLabelHash, ETH_NODE);
    expect(BASE_ETH_NODE).toBe(computed);
  });

  it("LINEA_ETH_NODE is the namehash of 'linea.eth'", () => {
    expect(LINEA_ETH_NODE).toBe(
      "0x527aac89ac1d1de5dd84cff89ec92c69b028ce9ce3fa3d654882474ab4402ec3",
    );
    const { keccak256, encodePacked } = require("viem");
    const lineaLabelHash = keccak256(encodePacked(["string"], ["linea"]));
    const computed = makeSubdomainNode(lineaLabelHash, ETH_NODE);
    expect(LINEA_ETH_NODE).toBe(computed);
  });

  it("THREEDNS_RESOLVER is the correct address", () => {
    expect(THREEDNS_RESOLVER).toBe(
      "0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8",
    );
  });
});

// ─── makeSubdomainNode ──────────────────────────────────────────────────────

describe("makeSubdomainNode", () => {
  it("computes the eth node from ROOT_NODE + keccak256('eth')", () => {
    // keccak256("eth") = 0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0
    const ethLabelHash =
      "0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0";
    const result = makeSubdomainNode(ethLabelHash, ROOT_NODE);
    expect(result).toBe(ETH_NODE);
  });

  it("produces different nodes for different labels under same parent", () => {
    const label1 =
      "0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0";
    const label2 =
      "0x5f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0";
    const node1 = makeSubdomainNode(label1, ROOT_NODE);
    const node2 = makeSubdomainNode(label2, ROOT_NODE);
    expect(node1).not.toBe(node2);
  });

  it("produces different nodes for same label under different parents", () => {
    const label =
      "0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0";
    const node1 = makeSubdomainNode(label, ROOT_NODE);
    const node2 = makeSubdomainNode(label, ETH_NODE);
    expect(node1).not.toBe(node2);
  });

  it("returns a 66-char hex string", () => {
    const label =
      "0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0";
    const result = makeSubdomainNode(label, ROOT_NODE);
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ─── ID Generation ──────────────────────────────────────────────────────────

describe("makeResolverId", () => {
  it("formats as chainId-address-node", () => {
    expect(makeResolverId(1, "0xabc", "0xdef")).toBe("1-0xabc-0xdef");
  });

  it("handles different chain IDs", () => {
    expect(makeResolverId(137, "0xabc", "0xdef")).toBe("137-0xabc-0xdef");
  });
});

describe("makeEventId", () => {
  it("formats as chainId-blockNumber-logIndex", () => {
    expect(makeEventId(1, 12345, 0)).toBe("1-12345-0");
  });

  it("appends transferIndex when provided", () => {
    expect(makeEventId(1, 12345, 0, 3)).toBe("1-12345-0-3");
  });

  it("includes transferIndex 0 when explicitly passed", () => {
    expect(makeEventId(1, 12345, 0, 0)).toBe("1-12345-0-0");
  });

  it("omits transferIndex when undefined", () => {
    expect(makeEventId(1, 12345, 0, undefined)).toBe("1-12345-0");
    expect(makeEventId(1, 12345, 0)).toBe("1-12345-0");
  });
});

describe("makeRegistrationId", () => {
  it("returns the node for cross-registrar uniqueness", () => {
    const labelHash = "0xabc";
    const node = "0xdef";
    expect(makeRegistrationId(labelHash, node)).toBe(node);
  });
});

// ─── tokenIdToLabelHash ─────────────────────────────────────────────────────

describe("tokenIdToLabelHash", () => {
  it("converts a bigint tokenId to a 0x-prefixed 64-char hex string", () => {
    const tokenId = 0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0n;
    expect(tokenIdToLabelHash(tokenId)).toBe(
      "0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0",
    );
  });

  it("pads small values to 64 hex chars", () => {
    expect(tokenIdToLabelHash(1n)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("handles zero", () => {
    expect(tokenIdToLabelHash(0n)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});

// ─── encodeLabelHash ────────────────────────────────────────────────────────

describe("encodeLabelHash", () => {
  it("wraps hex in brackets without 0x prefix", () => {
    const hash =
      "0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0";
    expect(encodeLabelHash(hash)).toBe(
      "[4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0]",
    );
  });
});

// ─── sharedEventValues ──────────────────────────────────────────────────────

describe("sharedEventValues", () => {
  it("extracts id, blockNumber, transactionID, and timestamp", () => {
    const event = {
      block: { number: 12345, timestamp: 1700000000 },
      logIndex: 7,
      transaction: { hash: "0xtxhash" },
    };
    const result = sharedEventValues(1, event);
    expect(result).toEqual({
      id: "1-12345-7",
      blockNumber: 12345,
      transactionID: "0xtxhash",
      timestamp: 1700000000n,
    });
  });
});

// ─── Utility Functions ──────────────────────────────────────────────────────

describe("bigintMax", () => {
  it("returns the larger of two bigints", () => {
    expect(bigintMax(10n, 20n)).toBe(20n);
    expect(bigintMax(20n, 10n)).toBe(20n);
  });

  it("returns either when equal", () => {
    expect(bigintMax(10n, 10n)).toBe(10n);
  });

  it("works with zero", () => {
    expect(bigintMax(0n, 5n)).toBe(5n);
    expect(bigintMax(5n, 0n)).toBe(5n);
  });

  it("works with negative bigints", () => {
    expect(bigintMax(-10n, -5n)).toBe(-5n);
  });
});

describe("uniq", () => {
  it("removes duplicate strings", () => {
    expect(uniq(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("removes duplicate numbers", () => {
    expect(uniq([1, 2, 1, 3])).toEqual([1, 2, 3]);
  });

  it("removes duplicate bigints", () => {
    expect(uniq([1n, 2n, 1n, 3n])).toEqual([1n, 2n, 3n]);
  });

  it("returns empty array for empty input", () => {
    expect(uniq([])).toEqual([]);
  });

  it("preserves order of first occurrence", () => {
    expect(uniq(["c", "a", "b", "a"])).toEqual(["c", "a", "b"]);
  });
});

describe("hasNullByte", () => {
  it("returns true for strings containing null bytes", () => {
    expect(hasNullByte("hello\0world")).toBe(true);
  });

  it("returns false for normal strings", () => {
    expect(hasNullByte("hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasNullByte("")).toBe(false);
  });

  it("detects null byte at start", () => {
    expect(hasNullByte("\0hello")).toBe(true);
  });

  it("detects null byte at end", () => {
    expect(hasNullByte("hello\0")).toBe(true);
  });
});

describe("stripNullBytes", () => {
  it("removes null bytes from strings", () => {
    expect(stripNullBytes("hello\0world")).toBe("helloworld");
  });

  it("removes multiple null bytes", () => {
    expect(stripNullBytes("a\0b\0c\0")).toBe("abc");
  });

  it("returns empty string unchanged", () => {
    expect(stripNullBytes("")).toBe("");
  });

  it("returns normal string unchanged", () => {
    expect(stripNullBytes("hello")).toBe("hello");
  });
});

// ─── decodeDnsEncodedName ──────────────────────────────────────────────────

describe("decodeDnsEncodedName", () => {
  it("decodes a simple two-label name", () => {
    // "foo.eth" → \x03foo\x03eth\x00
    const hex = "0x" + "03" + "666f6f" + "03" + "657468" + "00";
    expect(decodeDnsEncodedName(hex)).toEqual(["foo", "eth"]);
  });

  it("decodes a three-label name", () => {
    // "sub.foo.eth" → \x03sub\x03foo\x03eth\x00
    const hex = "0x" + "03" + "737562" + "03" + "666f6f" + "03" + "657468" + "00";
    expect(decodeDnsEncodedName(hex)).toEqual(["sub", "foo", "eth"]);
  });

  it("decodes a single-label TLD", () => {
    // "com" → \x03com\x00
    const hex = "0x" + "03" + "636f6d" + "00";
    expect(decodeDnsEncodedName(hex)).toEqual(["com"]);
  });

  it("returns empty array for root (just null terminator)", () => {
    expect(decodeDnsEncodedName("0x00")).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(decodeDnsEncodedName("0x")).toEqual([]);
  });

  it("handles input without 0x prefix", () => {
    const hex = "03" + "666f6f" + "03" + "657468" + "00";
    expect(decodeDnsEncodedName(hex)).toEqual(["foo", "eth"]);
  });

  it("decodes longer labels correctly", () => {
    // "example.com" → \x07example\x03com\x00
    const hex = "0x" + "07" + "6578616d706c65" + "03" + "636f6d" + "00";
    expect(decodeDnsEncodedName(hex)).toEqual(["example", "com"]);
  });
});

describe("indexable string guard", () => {
  it("accepts strings at the limit", () => {
    expect(isIndexable("a".repeat(MAX_INDEXED_STRING_BYTES))).toBe(true);
  });

  it("rejects strings over the limit", () => {
    expect(isIndexable("a".repeat(MAX_INDEXED_STRING_BYTES + 1))).toBe(false);
  });

  it("measures bytes, not characters", () => {
    expect(isIndexable("é".repeat(MAX_INDEXED_STRING_BYTES / 2 + 1))).toBe(false);
  });

  it("returns undefined for oversized or undefined input", () => {
    expect(indexableOrUndefined("a".repeat(23_000))).toBeUndefined();
    expect(indexableOrUndefined(undefined)).toBeUndefined();
    expect(indexableOrUndefined("vitalik")).toBe("vitalik");
  });
});

describe("isInterpretableLabel", () => {
  it("accepts ordinary labels", () => {
    expect(isInterpretableLabel("vitalik")).toBe(true);
    expect(isInterpretableLabel("🦊")).toBe(true);
  });

  it("rejects labels that would not round-trip to the node", () => {
    expect(isInterpretableLabel("")).toBe(false);
    expect(isInterpretableLabel("a.b")).toBe(false);
    expect(isInterpretableLabel("[abc]")).toBe(false);
    expect(isInterpretableLabel("a\0b")).toBe(false);
  });
});

describe("emptyToUndefined", () => {
  it("maps empty values to undefined", () => {
    expect(emptyToUndefined("")).toBeUndefined();
    expect(emptyToUndefined("0x")).toBeUndefined();
    expect(emptyToUndefined(undefined)).toBeUndefined();
  });

  it("keeps real values", () => {
    expect(emptyToUndefined("0xe301")).toBe("0xe301");
  });
});

describe("setDomain", () => {
  const base = {
    id: "0xnode",
    name: "foo.eth",
    labelName: "foo",
    labelhash: "0xlabel",
    parent_id: ETH_NODE,
    subdomainCount: 0,
    resolvedAddress_id: undefined,
    resolver_id: undefined,
    ttl: undefined,
    isMigrated: true,
    createdAt: 1n,
    owner_id: "0xregistryowner",
    registrant_id: undefined,
    wrappedOwner_id: undefined,
    expiryDate: undefined,
  };

  function capture() {
    const written: any[] = [];
    const context = { Subgraph_domain: { set: (d: any) => written.push(d) } };
    return { context: context as any, written };
  }

  it("uses the registry owner as effectiveOwner when not wrapped", () => {
    const { context, written } = capture();
    setDomain(context, base);
    expect(written[0].effectiveOwner_id).toBe("0xregistryowner");
  });

  it("uses the wrapped owner as effectiveOwner when wrapped", () => {
    const { context, written } = capture();
    setDomain(context, { ...base, wrappedOwner_id: "0xwrappedowner" });
    expect(written[0].effectiveOwner_id).toBe("0xwrappedowner");
  });

  it("recomputes a stale effectiveOwner on unwrap", () => {
    const { context, written } = capture();
    setDomain(context, {
      ...base,
      effectiveOwner_id: "0xwrappedowner",
      wrappedOwner_id: undefined,
    });
    expect(written[0].effectiveOwner_id).toBe("0xregistryowner");
  });
});

describe("namespaceForNewDomain", () => {
  it("puts the eth TLD in eth", () => {
    expect(namespaceForNewDomain(ETH_NODE, ROOT_NODE, undefined)).toBe("eth");
  });

  it("assigns children of managed registrar roots to that registrar", () => {
    expect(namespaceForNewDomain("0xa", ETH_NODE, "eth")).toBe("eth");
    expect(namespaceForNewDomain("0xa", BASE_ETH_NODE, "eth")).toBe("base");
    expect(namespaceForNewDomain("0xa", LINEA_ETH_NODE, "eth")).toBe("linea");
  });

  it("inherits from the parent otherwise", () => {
    expect(namespaceForNewDomain("0xa", "0xparent", "base")).toBe("base");
    expect(namespaceForNewDomain("0xa", "0xparent", undefined)).toBeUndefined();
  });
});

describe("namehashFromLabels", () => {
  it("matches known namehashes", () => {
    expect(namehashFromLabels(["eth"])).toBe(ETH_NODE);
    expect(namehashFromLabels(["base", "eth"])).toBe(BASE_ETH_NODE);
    expect(namehashFromLabels([])).toBe(ROOT_NODE);
  });

  it("does not reproduce a node from a label with replaced invalid UTF-8", () => {
    // "a\xff" is invalid UTF-8; decoding yields "a\ufffd", whose hash differs
    const { keccak256 } = require("viem");
    const original = makeSubdomainNode(
      keccak256(new Uint8Array([0x61, 0xff])),
      ETH_NODE,
    );
    expect(namehashFromLabels(["a\ufffd", "eth"])).not.toBe(original);
  });
});

describe("syncParentSubdomainCountOnEmptinessChange", () => {
  const mk = (id: string, over: Record<string, unknown> = {}): any => ({
    id,
    name: undefined,
    labelName: undefined,
    labelhash: undefined,
    parent_id: undefined,
    subdomainCount: 0,
    resolvedAddress_id: undefined,
    resolver_id: undefined,
    ttl: undefined,
    isMigrated: true,
    createdAt: 1n,
    owner_id: "0xowner",
    registrant_id: undefined,
    wrappedOwner_id: undefined,
    expiryDate: undefined,
    ...over,
  });

  function store(domains: any[]) {
    const m = new Map(domains.map((d) => [d.id, d]));
    const context = {
      Subgraph_domain: {
        get: async (id: string) => m.get(id),
        set: (d: any) => m.set(d.id, d),
      },
    } as any;
    return { m, context };
  }

  it("decrements the parent once when a domain becomes empty", async () => {
    const parent = mk("p", { subdomainCount: 2, owner_id: "0xp" });
    const before = mk("c", { parent_id: "p" });
    const { m, context } = store([parent, before]);
    m.set("c", { ...before, owner_id: ZERO_ADDRESS });
    await syncParentSubdomainCountOnEmptinessChange(context, before);
    expect(m.get("p").subdomainCount).toBe(1);
  });

  it("does not decrement again for another zero event on an empty domain", async () => {
    const parent = mk("p", { subdomainCount: 1, owner_id: "0xp" });
    const before = mk("c", { parent_id: "p", owner_id: ZERO_ADDRESS });
    const { m, context } = store([parent, before]);
    await syncParentSubdomainCountOnEmptinessChange(context, before);
    expect(m.get("p").subdomainCount).toBe(1);
  });

  it("counts a re-claimed domain again", async () => {
    const parent = mk("p", { subdomainCount: 0, owner_id: "0xp" });
    const before = mk("c", { parent_id: "p", owner_id: ZERO_ADDRESS });
    const { m, context } = store([parent, before]);
    m.set("c", { ...before, owner_id: "0xnew" });
    await syncParentSubdomainCountOnEmptinessChange(context, before);
    expect(m.get("p").subdomainCount).toBe(1);
  });

  it("re-counts up the chain when the parent was itself empty", async () => {
    const gp = mk("gp", { subdomainCount: 0, owner_id: "0xgp" });
    const parent = mk("p", { parent_id: "gp", subdomainCount: 0, owner_id: ZERO_ADDRESS });
    const before = mk("c", { parent_id: "p", owner_id: ZERO_ADDRESS });
    const { m, context } = store([gp, parent, before]);
    m.set("c", { ...before, resolver_id: "r" });
    await syncParentSubdomainCountOnEmptinessChange(context, before);
    expect(m.get("p").subdomainCount).toBe(1);
    expect(m.get("gp").subdomainCount).toBe(1);
  });

  it("does nothing when emptiness does not change", async () => {
    const parent = mk("p", { subdomainCount: 3, owner_id: "0xp" });
    const before = mk("c", { parent_id: "p" });
    const { m, context } = store([parent, before]);
    m.set("c", { ...before, owner_id: "0xother" });
    await syncParentSubdomainCountOnEmptinessChange(context, before);
    expect(m.get("p").subdomainCount).toBe(3);
  });
});
