import { describe, it, expect } from "vitest";
import { evmChainIdToCoinType } from "../src/lib/protocol-acceleration";

describe("evmChainIdToCoinType", () => {
  it("maps mainnet to coin type 60", () => {
    expect(evmChainIdToCoinType(1)).toBe(60);
  });

  it("returns an unsigned ENSIP-11 coin type for other chains", () => {
    expect(evmChainIdToCoinType(8453)).toBe(2147492101);
    expect(evmChainIdToCoinType(10)).toBe(2147483658);
  });
});
