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
  sharedEventValues,
  ROOT_NODE,
  ETH_NODE,
  ADDR_REVERSE_NODE,
  ZERO_ADDRESS,
  GRACE_PERIOD_SECONDS,
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
  it("extracts id, blockNumber, and transactionID", () => {
    const event = {
      block: { number: 12345 },
      logIndex: 7,
      transaction: { hash: "0xtxhash" },
    };
    const result = sharedEventValues(1, event);
    expect(result).toEqual({
      id: "1-12345-7",
      blockNumber: 12345,
      transactionID: "0xtxhash",
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
