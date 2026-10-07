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
