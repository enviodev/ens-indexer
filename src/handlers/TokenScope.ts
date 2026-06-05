import { indexer } from "envio";

import {
  makeEventId,
  upsertAccount,
} from "../lib/helpers";

import {
  formatAssetId,
  getSupportedSaleFromOrderFulfilledEvent,
} from "../lib/tokenscope-helpers";

// ─── Seaport.OrderFulfilled (secondary market sales) ────────────────────────

indexer.onEvent({ contract: "Seaport", event: "OrderFulfilled" }, async ({ event, context }) => {
  const sale = getSupportedSaleFromOrderFulfilledEvent(
    event.chainId,
    event.params.orderHash,
    event.params.offerer,
    event.params.recipient,
    event.params.offer,
    event.params.consideration,
  );

  // Unsupported sale (multi-NFT, multi-currency, unsupported contract, etc.)
  if (!sale) return;

  // Upsert buyer and seller accounts
  upsertAccount(context, sale.seller);
  upsertAccount(context, sale.buyer);

  const assetIdString = formatAssetId(sale.nft);

  // Insert NameSale entity
  context.name_sale.set({
    id: makeEventId(event.chainId, event.block.number, event.logIndex),
    chainId: sale.nft.chainId,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    transactionHash: event.transaction.hash,
    orderHash: sale.orderHash,
    contractAddress: sale.nft.contractAddress,
    tokenId: sale.nft.tokenId,
    assetNamespace: sale.nft.assetNamespace,
    assetId: assetIdString,
    domainId: sale.nft.domainId,
    buyer: sale.buyer,
    seller: sale.seller,
    currency: sale.payment.currency,
    amount: sale.payment.amount,
    timestamp: BigInt(event.block.timestamp),
  });
});
