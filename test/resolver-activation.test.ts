import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { STATIC_RESOLVERS } from "../src/lib/resolver-activation";

describe("STATIC_RESOLVERS", () => {
  it("matches the Resolver addresses in config.yaml", () => {
    const config = readFileSync("config.yaml", "utf8");
    const chains = config.slice(config.indexOf("\nchains:")).split(/\n  - id: /).slice(1);
    for (const chunk of chains) {
      const chainId = Number(chunk.split(/\s/)[0]);
      const block = chunk.match(/      - name: Resolver\n((?:        .*\n)*)/);
      const addresses = block ? [...block[1]!.matchAll(/"(0x[0-9a-f]{40})"/g)].map((m) => m[1]) : [];
      expect([...(STATIC_RESOLVERS[chainId] ?? [])].sort()).toEqual(addresses.sort());
    }
  });
});
