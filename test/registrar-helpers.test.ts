import { createTestIndexer } from "envio";
import { describe, it, expect } from "vitest";
import {
  getOrCreateRegistrationLifecycle,
  updateRegistrationLifecycleExpiry,
} from "../src/lib/registrar-helpers";

const DAY = 86_400;

function fakeContext() {
  const lifecycles = new Map<string, any>();
  const buckets = new Map<string, any>();
  const context = {
    Registration_lifecycle: {
      get: async (id: string) => lifecycles.get(id),
      set: (v: any) => lifecycles.set(v.id, v),
    },
    Expiry_day_stat: {
      get: async (id: string) => buckets.get(id),
      set: (v: any) => buckets.set(v.id, v),
    },
  } as any;
  return { context, buckets };
}

describe("expiry day buckets", () => {
  it("counts a new registration in its expiry day", async () => {
    const { context, buckets } = fakeContext();
    await getOrCreateRegistrationLifecycle(context, "sub", "0xa", BigInt(10 * DAY + 5));
    expect(buckets.get("sub:10").count).toBe(1);
  });

  it("moves a registration between days on renewal", async () => {
    const { context, buckets } = fakeContext();
    await getOrCreateRegistrationLifecycle(context, "sub", "0xa", BigInt(10 * DAY));
    await updateRegistrationLifecycleExpiry(context, "0xa", BigInt(400 * DAY));
    expect(buckets.get("sub:10").count).toBe(0);
    expect(buckets.get("sub:400").count).toBe(1);
  });

  it("does not change buckets when the day is the same", async () => {
    const { context, buckets } = fakeContext();
    await getOrCreateRegistrationLifecycle(context, "sub", "0xa", BigInt(10 * DAY + 1));
    await updateRegistrationLifecycleExpiry(context, "0xa", BigInt(10 * DAY + 900));
    expect(buckets.get("sub:10").count).toBe(1);
  });

  it("moves a re-registration after expiry and keeps other names in the day", async () => {
    const { context, buckets } = fakeContext();
    await getOrCreateRegistrationLifecycle(context, "sub", "0xa", BigInt(10 * DAY));
    await getOrCreateRegistrationLifecycle(context, "sub", "0xb", BigInt(10 * DAY));
    await getOrCreateRegistrationLifecycle(context, "sub", "0xa", BigInt(500 * DAY));
    expect(buckets.get("sub:10").count).toBe(1);
    expect(buckets.get("sub:500").count).toBe(1);
  });
});

describe("expiry buckets for the ENSv2 cutover", () => {
  it("clamps a day number beyond Postgres int into one far-future bucket", async () => {
    const { expiryDay, MAX_EXPIRY_DAY } = await import("../src/lib/registrar-helpers");
    expect(expiryDay(18446744073701775615n)).toBe(MAX_EXPIRY_DAY);
    expect(expiryDay(1_800_000_000n)).toBe(20833);
  });

  it("does not count a Graveyard retirement at mainnet block 26,297,075 as a registration", async () => {
    // The .eth registrar re-registers an expired v1 name to the Graveyard with expiry
    // 18446744073701775615. That retires the name; it is not a registration.
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 1: { startBlock: 26_297_075, endBlock: 26_297_075 } } });
    // The in-memory test store does not enforce Postgres types, so check the range here.
    const all = await indexer.Expiry_day_stat.getAll();
    for (const b of all) expect(b.day).toBeLessThanOrEqual(2_147_483_647);
    expect(all.some((b: any) => b.day === 2_147_483_647)).toBe(false);
  }, 120_000);
});
