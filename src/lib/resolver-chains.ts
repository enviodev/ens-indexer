// Chains that list `Resolver` in config.yaml. Resolver handlers match by
// signature (wildcard), which HyperIndex applies on every chain; this keeps
// them to the chains that index ENS resolvers.
const RESOLVER_CHAINS = new Set([1, 8453, 59144, 10, 11155111]);

export function onResolverChains({ chain }: { chain: { id: number } }): boolean {
  return RESOLVER_CHAINS.has(chain.id);
}
