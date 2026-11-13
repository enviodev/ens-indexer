import { indexer } from "envio";
import { V2_DEPLOYMENTS } from "../lib/v2-deployments";
import { makeV2DomainId, makeV2EventId } from "../lib/v2-helpers";

// paymentToken, base and premium are stored as emitted. Amounts are in units of
// whichever ERC-20 paid, so consumers must not sum across tokens without
// normalising first.

function ethRegistryDomainId(chainId: number, tokenId: bigint): string {
  const registry = V2_DEPLOYMENTS[chainId]?.ethRegistry;
  if (!registry) throw new Error(`no ETHRegistry configured for chain ${chainId}`);
  return makeV2DomainId(chainId, registry, tokenId);
}

indexer.onEvent({ contract: "V2Registrar", event: "NameRegistered" }, async ({ event, context }) => {
  const { tokenId, label, owner, subregistry, resolver, duration, paymentToken, referrer, base, premium } = event.params;
  context.V2_registration.set({
    id: makeV2EventId(event.chainId, event.block.number, event.logIndex),
    domain_id: ethRegistryDomainId(event.chainId, tokenId),
    label,
    owner: owner.toLowerCase(),
    subregistry: subregistry.toLowerCase(),
    resolver: resolver.toLowerCase(),
    duration,
    paymentToken: paymentToken.toLowerCase(),
    base,
    premium,
    referrer,
    registrar: event.srcAddress.toLowerCase(),
    blockNumber: event.block.number,
    timestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
  });
});

indexer.onEvent({ contract: "V2Registrar", event: "NameRenewed" }, async ({ event, context }) => {
  const { tokenId, label, duration, newExpiry, paymentToken, referrer, amount } = event.params;
  const domainId = ethRegistryDomainId(event.chainId, tokenId);
  const domain = await context.V2_domain.get(domainId);
  context.V2_renewal.set({
    id: makeV2EventId(event.chainId, event.block.number, event.logIndex),
    domain_id: domain ? domainId : undefined,
    label,
    duration,
    newExpiry,
    paymentToken: paymentToken.toLowerCase(),
    amount,
    referrer,
    registrar: event.srcAddress.toLowerCase(),
    blockNumber: event.block.number,
    timestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
  });
});
