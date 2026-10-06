import { describe, it, expect } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  evmChainIdToCoinType,
  addressForReverseLabel,
} from "../src/lib/protocol-acceleration";

describe("evmChainIdToCoinType", () => {
  it("maps mainnet to coin type 60", () => {
    expect(evmChainIdToCoinType(1)).toBe(60);
  });

  it("returns an unsigned ENSIP-11 coin type for other chains", () => {
    expect(evmChainIdToCoinType(8453)).toBe(2147492101);
    expect(evmChainIdToCoinType(10)).toBe(2147483658);
  });
});

describe("addressForReverseLabel", () => {
  const addr = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  const label = keccak256(toBytes(addr.slice(2)));

  it("accepts a candidate that reproduces the label", () => {
    expect(addressForReverseLabel(label, ["0xother", addr])).toBe(addr);
  });

  it("normalises checksummed candidates to lowercase", () => {
    expect(
      addressForReverseLabel(label, ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]),
    ).toBe(addr);
  });

  it("returns null when no candidate matches or the label is unknown", () => {
    expect(
      addressForReverseLabel(label, ["0x0000000000000000000000000000000000000001"]),
    ).toBeNull();
    expect(addressForReverseLabel(undefined, [addr])).toBeNull();
  });
});
