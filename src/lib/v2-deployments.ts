// ENSv2 deployment seeds, per chain.
//
// Source: ensdomains/contracts-v2, branch deploy/mainnet-v2-20261002, commit
// 0f10caf54, contracts/deployments/{mainnet,sepolia}. The mainnet set is the
// one recorded after the 2026-10-26 redeploy; earlier addresses come from the
// mainnet-root-20261013 and mainnet-redeploy-* folders on the same branch.
//
// Only these registries are trusted without a parent link. Everything else must
// be reached from one of them.

export interface V2Deployment {
  rootRegistry: string;
  ethRegistry: string;
  batchRegistrars: readonly string[];
  migrationControllers: readonly string[];
  // Resolvers that only forward to another resolver and emit no record events.
  // ResolverUpdated points at these about a million times during premigration.
  mirrorResolvers: readonly string[];
}

export const V2_DEPLOYMENTS: Record<number, V2Deployment> = {
  1: {
    rootRegistry: "0x2553c09be6447beffdb86fa622ad41fb8f77a91e",
    ethRegistry: "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2",
    batchRegistrars: [
      "0xf0ccfbf6dba1e01ccb833ced6d551a8f000e9721",
      "0xe467ae049ddd65a21fb85b5f1de5f7997a8eb164",
      "0x4547fe3a831b041aecdfb2f1616d6faae99e6cc1",
    ],
    migrationControllers: [
      "0x3cea18620883a69ed349b23328a3b6302598e51a",
      "0x811814c098378488f916afa89f43b36baa5425ad",
      "0xc46bf3b6c7ebcffd4ecfc3b012a1726a2463694d",
      "0xa19d4d49230200b3e81290a87dd12ea916af7be6",
      "0x4d5179122a3b811766a409c93466a37704792e17",
      "0xab821ca676cf2e0790fa273526a165cfa86aeb64",
    ],
    mirrorResolvers: [
      "0x394d8eb4a4fdf599384deab25f31d111d755c398", // ENSV1Resolver
      "0x3071ad643ce4ed8b3d67b289845b45db82b068a4", // ENSV2Resolver
      "0xa6d451c5e283bdd0a7c193910f55db57512aa7b2",
      "0x8486d32948cdef5c24236718318c6326d5d006a9",
    ],
  },
  11155111: {
    rootRegistry: "0xb458d6a3a77919449d03e7a6903c26827c1ec43f",
    ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
    batchRegistrars: [
      "0x4a4c8b7cdab6b19dc2cdb417cdb53a2ccbaf5322",
      "0x4cdedc6b514a6bc9b64854dfe2d6849d5b1369a6",
    ],
    migrationControllers: [
      "0x6029a063d69b09d23c52a754a90e4fe43adac3a8",
      "0x2a35b94df22cc7354570be2284655e2cdc0e64a2",
    ],
    mirrorResolvers: [
      "0x322b7581ca210a69c6d0e0d7c88a7688d2789cb0", // ENSV1Resolver
      "0x1cf3989ed3e5ec3cb1d731fc3777323813b61acf", // ENSV2Resolver
    ],
  },
};

export type SeedKind = "root" | "eth";

export function seedKind(chainId: number, address: string): SeedKind | undefined {
  const d = V2_DEPLOYMENTS[chainId];
  if (!d) return undefined;
  const a = address.toLowerCase();
  if (a === d.rootRegistry) return "root";
  if (a === d.ethRegistry) return "eth";
  return undefined;
}

export function isBatchRegistrar(chainId: number, sender: string): boolean {
  return V2_DEPLOYMENTS[chainId]?.batchRegistrars.includes(sender.toLowerCase()) ?? false;
}

export function isMigrationController(chainId: number, sender: string): boolean {
  return V2_DEPLOYMENTS[chainId]?.migrationControllers.includes(sender.toLowerCase()) ?? false;
}

export function isMirrorResolver(chainId: number, address: string): boolean {
  return V2_DEPLOYMENTS[chainId]?.mirrorResolvers.includes(address.toLowerCase()) ?? false;
}
