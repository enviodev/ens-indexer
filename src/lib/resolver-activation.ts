import type { handlerContext } from "./helpers";

// Resolvers listed under `Resolver` in config.yaml, active from each chain's
// start. Keep in sync with config.yaml (test/resolver-activation.test.ts checks it).
export const STATIC_RESOLVERS: Record<number, readonly string[]> = {
  1: [
    "0x231b0ee14048e9dccd1d247744d114a4eb5e8e63",
    "0xa7d635c8de9a58a228aa69353a1699c7cc240dcf",
    "0xc800dbc8ff9796e58efba2d7b35028ddd1997e5e",
    "0x0ce08a41bdb10420fb5cac7da8ca508ea313aef8",
    "0xf9edb1a21867ac11b023ce34abad916d29abf107",
    "0x4b9572c03aaa8b0efa4b4b0f0cc0f0992bedb898",
    "0xc4842814ca523e481ca5aa85f719fed1e9cac614",
  ],
  8453: ["0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8"],
  10: ["0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8"],
};

const id = (chainId: number, address: string) => `${chainId}-${address.toLowerCase()}`;

/** Record that a registry assigned this resolver. The earliest block wins. */
export async function activateResolver(
  context: handlerContext,
  chainId: number,
  address: string,
  block: number,
): Promise<void> {
  const key = id(chainId, address);
  const existing = await context.Resolver_activation.get(key);
  if (!existing || existing.firstBlock > block) {
    context.Resolver_activation.set({ id: key, firstBlock: block });
  }
}

/**
 * Whether events from this resolver count at this block. Same-block events count
 * even if they come before the assignment, as with HyperIndex dynamic contracts.
 */
export async function isActiveResolver(
  context: handlerContext,
  chainId: number,
  address: string,
  block: number,
): Promise<boolean> {
  const a = address.toLowerCase();
  if (STATIC_RESOLVERS[chainId]?.includes(a)) return true;
  const row = await context.Resolver_activation.get(id(chainId, a));
  return row !== undefined && row.firstBlock <= block;
}
