// Which protocol answers for a name. No database or package imports, so the
// indexer tests can load it without the API's dependencies.

export const DEPLOYMENTS = {
  1: { root: "0x2553c09be6447beffdb86fa622ad41fb8f77a91e", v1Mirror: ["0x394d8eb4a4fdf599384deab25f31d111d755c398"], v2Mirror: ["0x3071ad643ce4ed8b3d67b289845b45db82b068a4"] },
  11155111: { root: "0xb458d6a3a77919449d03e7a6903c26827c1ec43f", v1Mirror: ["0x322b7581ca210a69c6d0e0d7c88a7688d2789cb0"], v2Mirror: ["0x1cf3989ed3e5ec3cb1d731fc3777323813b61acf"] },
};

/**
 * Which protocol answers for a name, from the ENSv2 walk alone.
 *
 * - A name registered on v2 is answered by v2. If its resolver only mirrors
 *   v1 (ENSV1Resolver), its records still come from v1.
 * - A name only reserved on v2 (premigration) is still answered by v1, unless
 *   its owner has set a real v2 resolver.
 * - With no exact entry, a v2 ancestor's resolver answers (wildcard).
 * - Otherwise v1 answers.
 */
export function decideAuthority({ leaf, resolver, deployment }) {
  const v1Mirror = deployment?.v1Mirror.includes(resolver) ?? false;
  const v2Mirror = deployment?.v2Mirror.includes(resolver) ?? false;
  const realV2Resolver = Boolean(resolver) && !v1Mirror && !v2Mirror;
  if (leaf && (leaf.status === "REGISTERED" || (leaf.status === "RESERVED" && realV2Resolver))) {
    return { authority: "v2", records: realV2Resolver ? "v2" : v1Mirror ? "v1" : "none", wildcard: false };
  }
  if (!leaf && realV2Resolver) return { authority: "v2", records: "v2", wildcard: true };
  return { authority: "v1", records: "v1", wildcard: false, reason: leaf?.status === "RESERVED" ? "reserved on v2, not migrated" : "not on v2" };
}
