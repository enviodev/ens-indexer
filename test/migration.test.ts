import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { namehash } from "viem";
import { makeV2DomainId } from "../src/lib/v2-helpers";
// @ts-ignore -- plain ESM module from the API package
import { decideAuthority, DEPLOYMENTS } from "../api/src/resolve.mjs";

// A real Sepolia name, birena.eth: premigrated (reserved on v2 with the
// ENSV1Resolver mirror) at block 11,821,440, migrated by the unlocked migration
// controller at block 11,909,868. The API must answer from v1 before migration
// and from v2 after.

const CHAIN = 11155111;
const ETH_REGISTRY = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4";
const TOKEN = BigInt("0x1f98eb0eb5404a3614008e6d10f334144668241fd4f80c01d99f698700000000");
const deployment = DEPLOYMENTS[CHAIN];

describe("v1 to v2 migration (Sepolia, birena.eth)", () => {
  it("answers from v1 while reserved, and from v2 once migrated", async () => {
    const indexer = createTestIndexer();
    const id = makeV2DomainId(CHAIN, ETH_REGISTRY, TOKEN);

    await indexer.process({ chains: { [CHAIN]: { startBlock: 11_821_440, endBlock: 11_821_440 } } });
    const reserved = await indexer.V2_domain.getOrThrow(id);
    expect(reserved.status).toBe("RESERVED");
    expect(reserved.isPremigrated).toBe(true);
    expect(deployment.v1Mirror).toContain(reserved.resolver);
    const before = decideAuthority({ leaf: reserved, resolver: reserved.resolver, deployment });
    expect(before.authority).toBe("v1");
    expect(before.reason).toBe("reserved on v2, not migrated");

    await indexer.process({ chains: { [CHAIN]: { startBlock: 11_909_868, endBlock: 11_909_868 } } });
    const migrated = await indexer.V2_domain.getOrThrow(id);
    expect(migrated.status).toBe("REGISTERED");
    expect(migrated.isMigrated).toBe(true);
    const after = decideAuthority({ leaf: migrated, resolver: migrated.resolver, deployment });
    expect(after.authority).toBe("v2");

    const ledger = await indexer.V2_migration.getOrThrow(namehash("birena.eth"));
    expect(ledger.blockNumber).toBe(11_909_868);
    expect(ledger.owner).toBe(migrated.owner);
  });

  it("keeps records on v1 for a v2 name whose resolver only mirrors v1", () => {
    const leaf = { status: "REGISTERED" };
    expect(decideAuthority({ leaf, resolver: deployment.v1Mirror[0], deployment })).toMatchObject({ authority: "v2", records: "v1" });
  });

  it("lets a reserved name with a real v2 resolver answer from v2", () => {
    const leaf = { status: "RESERVED" };
    expect(decideAuthority({ leaf, resolver: "0x00000000000000000000000000000000000000aa", deployment })).toMatchObject({ authority: "v2", records: "v2" });
  });

  it("falls back to v1 for a name v2 does not know", () => {
    expect(decideAuthority({ leaf: undefined, resolver: undefined, deployment }).authority).toBe("v1");
  });
});
