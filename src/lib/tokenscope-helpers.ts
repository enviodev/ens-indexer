import { type Address, isAddressEqual, zeroAddress } from "viem";
import type { handlerContext } from "generated";

import {
  ETH_NODE,
  BASE_ETH_NODE,
  LINEA_ETH_NODE,
  makeSubdomainNode,
  makeEventId,
  upsertAccount,
  tokenIdToLabelHash,
} from "./helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

export const NFTMintStatuses = {
  Minted: "minted",
  Burned: "burned",
} as const;

export type NFTMintStatus =
  (typeof NFTMintStatuses)[keyof typeof NFTMintStatuses];

export const AssetNamespaces = {
  ERC721: "erc721",
  ERC1155: "erc1155",
} as const;

export type AssetNamespace =
  (typeof AssetNamespaces)[keyof typeof AssetNamespaces];

export const CurrencyIds = {
  ETH: "ETH",
  USDC: "USDC",
  DAI: "DAI",
} as const;

export type CurrencyId = (typeof CurrencyIds)[keyof typeof CurrencyIds];

// ─── NFT Types ──────────────────────────────────────────────────────────────

export interface DomainAssetId {
  assetNamespace: AssetNamespace;
  chainId: number;
  contractAddress: string;
  tokenId: bigint;
  domainId: string; // namehash (node)
}

// ─── CAIP-19 Asset ID Formatting ────────────────────────────────────────────

/**
 * Convert a bigint to a 0x-prefixed 64-char hex string (uint256).
 */
function uint256ToHex32(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

/**
 * Format a DomainAssetId as a CAIP-19 asset ID string.
 * Format: eip155:{chainId}/{assetNamespace}:{address}/{tokenId}
 * Always lowercase.
 */
export function formatAssetId(nft: DomainAssetId): string {
  return `eip155:${nft.chainId}/${nft.assetNamespace}:${nft.contractAddress}/${uint256ToHex32(nft.tokenId)}`.toLowerCase();
}

// ─── Supported NFT Issuers ──────────────────────────────────────────────────

interface SupportedNFTIssuer {
  assetNamespace: AssetNamespace;
  chainId: number;
  contractAddress: string;
  getDomainId: (tokenId: bigint) => string;
}

/**
 * All known NFT issuers in our indexer.
 * - BaseRegistrar: ERC721, tokenId = labelHash → compose with parent node
 * - NameWrapper: ERC1155, tokenId = namehash → node directly
 * - ThreeDNSToken: ERC1155, tokenId = namehash → node directly
 */
const SUPPORTED_NFT_ISSUERS: SupportedNFTIssuer[] = [
  // Mainnet BaseRegistrar (.eth)
  {
    assetNamespace: AssetNamespaces.ERC721,
    chainId: 1,
    contractAddress: "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85",
    getDomainId: (tokenId: bigint) =>
      makeSubdomainNode(tokenIdToLabelHash(tokenId), ETH_NODE),
  },
  // Mainnet NameWrapper
  {
    assetNamespace: AssetNamespaces.ERC1155,
    chainId: 1,
    contractAddress: "0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401",
    getDomainId: (tokenId: bigint) => uint256ToHex32(tokenId),
  },
  // Base BaseRegistrar (.base.eth)
  {
    assetNamespace: AssetNamespaces.ERC721,
    chainId: 8453,
    contractAddress: "0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a",
    getDomainId: (tokenId: bigint) =>
      makeSubdomainNode(tokenIdToLabelHash(tokenId), BASE_ETH_NODE),
  },
  // Linea BaseRegistrar (.linea.eth)
  {
    assetNamespace: AssetNamespaces.ERC721,
    chainId: 59144,
    contractAddress: "0x6e84390dcc5195414ec91a8c56a5c91021b95704",
    getDomainId: (tokenId: bigint) =>
      makeSubdomainNode(tokenIdToLabelHash(tokenId), LINEA_ETH_NODE),
  },
  // ThreeDNS on Optimism
  {
    assetNamespace: AssetNamespaces.ERC1155,
    chainId: 10,
    contractAddress: "0xbb7b805b257d7c76ca9435b3ffe780355e4c4b17",
    getDomainId: (tokenId: bigint) => uint256ToHex32(tokenId),
  },
  // ThreeDNS on Base
  {
    assetNamespace: AssetNamespaces.ERC1155,
    chainId: 8453,
    contractAddress: "0xbb7b805b257d7c76ca9435b3ffe780355e4c4b17",
    getDomainId: (tokenId: bigint) => uint256ToHex32(tokenId),
  },
];

/**
 * Find a supported NFT issuer by chain + address.
 */
export function getSupportedNFTIssuer(
  chainId: number,
  contractAddress: string,
): SupportedNFTIssuer | undefined {
  return SUPPORTED_NFT_ISSUERS.find(
    (issuer) =>
      issuer.chainId === chainId &&
      issuer.contractAddress === contractAddress.toLowerCase(),
  );
}

/**
 * Build a DomainAssetId from known issuer parameters.
 * Used by handlers that already know their contract details.
 */
export function buildDomainAssetId(
  chainId: number,
  contractAddress: string,
  tokenId: bigint,
  assetNamespace: AssetNamespace,
  getDomainId: (tokenId: bigint) => string,
): DomainAssetId {
  return {
    assetNamespace,
    chainId,
    contractAddress: contractAddress.toLowerCase(),
    tokenId,
    domainId: getDomainId(tokenId),
  };
}

// ─── NFT Transfer Type Detection ────────────────────────────────────────────

const NFTTransferTypes = {
  Mint: "mint",
  Remint: "remint",
  MintedRemint: "minted-remint",
  Burn: "burn",
  Transfer: "transfer",
  SelfTransfer: "self-transfer",
  RemintBurn: "remint-burn",
  MintedRemintBurn: "minted-remint-burn",
  MintBurn: "mint-burn",
} as const;

type NFTTransferType =
  (typeof NFTTransferTypes)[keyof typeof NFTTransferTypes];

function getNFTTransferType(
  from: string,
  to: string,
  allowMintedRemint: boolean,
  currentlyIndexedOwner?: string,
): NFTTransferType {
  const isIndexed = currentlyIndexedOwner !== undefined;
  const isIndexedAsMinted =
    isIndexed &&
    !isAddressEqual(
      currentlyIndexedOwner as Address,
      zeroAddress,
    );

  const isMint = isAddressEqual(from as Address, zeroAddress);
  const isBurn = isAddressEqual(to as Address, zeroAddress);
  const isSelfTransfer = isAddressEqual(from as Address, to as Address);

  if (isSelfTransfer) {
    if (isMint) {
      if (!isIndexed) return NFTTransferTypes.MintBurn;
      if (!isIndexedAsMinted) return NFTTransferTypes.RemintBurn;
      if (allowMintedRemint) return NFTTransferTypes.MintedRemintBurn;
      throw new Error(
        `Invalid state transition from minted -> remint-burn`,
      );
    } else {
      if (!isIndexed)
        // Token minted before our start_block — treat as late-discovered mint
        return NFTTransferTypes.Mint;
      if (!isIndexedAsMinted)
        throw new Error(`Invalid state transition from burned -> self-transfer`);
      return NFTTransferTypes.SelfTransfer;
    }
  } else if (isMint) {
    if (!isIndexed) return NFTTransferTypes.Mint;
    if (!isIndexedAsMinted) return NFTTransferTypes.Remint;
    if (allowMintedRemint) return NFTTransferTypes.MintedRemint;
    throw new Error(`Invalid state transition from minted -> mint`);
  } else if (isBurn) {
    if (!isIndexed)
      // Token minted before our start_block — treat as mint + burn
      return NFTTransferTypes.MintBurn;
    if (!isIndexedAsMinted)
      throw new Error(`Invalid state transition from burned -> burn`);
    return NFTTransferTypes.Burn;
  } else {
    if (!isIndexed)
      // Token minted before our start_block — treat as late-discovered mint
      return NFTTransferTypes.Mint;
    if (!isIndexedAsMinted)
      throw new Error(`Invalid state transition from burned -> transfer`);
    return NFTTransferTypes.Transfer;
  }
}

// ─── NFT Transfer Handling ──────────────────────────────────────────────────

/**
 * Handle an ERC1155 transfer event. Validates amount === 1n, then delegates
 * to handleNFTTransfer.
 */
export async function handleERC1155Transfer(
  context: handlerContext,
  from: string,
  to: string,
  allowMintedRemint: boolean,
  nft: DomainAssetId,
  amount: bigint,
): Promise<void> {
  if (amount !== 1n) {
    throw new Error(
      `ERC1155 transfer value must be 1, got ${amount} for asset ${formatAssetId(nft)}`,
    );
  }
  await handleNFTTransfer(context, from, to, allowMintedRemint, nft);
}

/**
 * Handle an NFT transfer event. Determines transfer type and updates
 * the NameToken entity accordingly.
 */
export async function handleNFTTransfer(
  context: handlerContext,
  from: string,
  to: string,
  allowMintedRemint: boolean,
  nft: DomainAssetId,
): Promise<void> {
  const assetIdString = formatAssetId(nft);

  const previous = await context.NameToken.get(assetIdString);
  const transferType = getNFTTransferType(
    from,
    to,
    allowMintedRemint,
    previous?.owner,
  );

  switch (transferType) {
    case NFTTransferTypes.Mint:
      upsertAccount(context, to);
      context.NameToken.set({
        id: assetIdString,
        chainId: nft.chainId,
        contractAddress: nft.contractAddress,
        tokenId: nft.tokenId,
        assetNamespace: nft.assetNamespace,
        domainId: nft.domainId,
        owner: to,
        mintStatus: NFTMintStatuses.Minted,
      });
      break;

    case NFTTransferTypes.MintBurn:
      upsertAccount(context, zeroAddress);
      context.NameToken.set({
        id: assetIdString,
        chainId: nft.chainId,
        contractAddress: nft.contractAddress,
        tokenId: nft.tokenId,
        assetNamespace: nft.assetNamespace,
        domainId: nft.domainId,
        owner: zeroAddress,
        mintStatus: NFTMintStatuses.Burned,
      });
      break;

    case NFTTransferTypes.Remint:
      upsertAccount(context, to);
      context.NameToken.set({
        ...previous!,
        owner: to,
        mintStatus: NFTMintStatuses.Minted,
      });
      break;

    case NFTTransferTypes.Burn:
    case NFTTransferTypes.MintedRemintBurn:
      upsertAccount(context, zeroAddress);
      context.NameToken.set({
        ...previous!,
        owner: zeroAddress,
        mintStatus: NFTMintStatuses.Burned,
      });
      break;

    case NFTTransferTypes.Transfer:
    case NFTTransferTypes.MintedRemint:
      upsertAccount(context, to);
      context.NameToken.set({
        ...previous!,
        owner: to,
      });
      break;

    case NFTTransferTypes.SelfTransfer:
    case NFTTransferTypes.RemintBurn:
      // No indexed state changes needed
      break;
  }
}

// ─── Seaport Types ──────────────────────────────────────────────────────────

enum ItemType {
  NATIVE = 0,
  ERC20 = 1,
  ERC721 = 2,
  ERC1155 = 3,
  ERC721_WITH_CRITERIA = 4,
  ERC1155_WITH_CRITERIA = 5,
}

// HyperIndex generates tuple arrays for Seaport struct arrays:
// offer: [itemType, token, identifier, amount]
// consideration: [itemType, token, identifier, amount, recipient]
export type OfferTuple = readonly [bigint, string, bigint, bigint];
export type ConsiderationTuple = readonly [bigint, string, bigint, bigint, string];

interface ParsedItem {
  itemType: number;
  token: string;
  identifier: bigint;
  amount: bigint;
}

interface SupportedPayment {
  currency: CurrencyId;
  amount: bigint;
}

export interface SupportedSale {
  orderHash: string;
  nft: DomainAssetId;
  payment: SupportedPayment;
  seller: string;
  buyer: string;
}

// ─── Currency Mapping ───────────────────────────────────────────────────────

// Mainnet-only since Seaport is only configured on mainnet
const SUPPORTED_CURRENCIES: Record<string, CurrencyId> = {
  // NATIVE (ETH) - zeroAddress
  "0x0000000000000000000000000000000000000000": CurrencyIds.ETH,
  // USDC on mainnet (note: Ponder source has 0xa0b86a33... which appears to be a typo,
  // the canonical USDC on mainnet is 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48)
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": CurrencyIds.USDC,
  // DAI on mainnet
  "0x6b175474e89094c44da98b954eedeac495271d0f": CurrencyIds.DAI,
};

function getCurrencyIdForToken(tokenAddress: string): CurrencyId | undefined {
  return SUPPORTED_CURRENCIES[tokenAddress.toLowerCase()];
}

// ─── Seaport Order Parsing ──────────────────────────────────────────────────

function getAssetNamespace(itemType: number): AssetNamespace | undefined {
  switch (itemType) {
    case ItemType.ERC721:
      return AssetNamespaces.ERC721;
    case ItemType.ERC1155:
      return AssetNamespaces.ERC1155;
    default:
      return undefined;
  }
}

function parseTupleToItem(tuple: OfferTuple | ConsiderationTuple): ParsedItem {
  return {
    itemType: Number(tuple[0]),
    token: tuple[1],
    identifier: tuple[2],
    amount: tuple[3],
  };
}

function getSupportedNFTFromItem(
  chainId: number,
  item: ParsedItem,
): DomainAssetId | undefined {
  if (item.amount !== 1n) return undefined;

  const assetNamespace = getAssetNamespace(item.itemType);
  if (!assetNamespace) return undefined;

  const issuer = getSupportedNFTIssuer(chainId, item.token);
  if (!issuer) return undefined;
  if (issuer.assetNamespace !== assetNamespace) return undefined;

  return {
    assetNamespace,
    chainId: issuer.chainId,
    contractAddress: issuer.contractAddress,
    tokenId: item.identifier,
    domainId: issuer.getDomainId(item.identifier),
  };
}

function getSupportedPaymentFromItem(
  item: ParsedItem,
): SupportedPayment | undefined {
  if (item.itemType !== ItemType.NATIVE && item.itemType !== ItemType.ERC20)
    return undefined;

  const currencyId = getCurrencyIdForToken(item.token);
  if (!currencyId) return undefined;

  // Sanity: NATIVE must be ETH, ERC20 must not be ETH
  if (item.itemType === ItemType.NATIVE && currencyId !== CurrencyIds.ETH)
    return undefined;
  if (item.itemType === ItemType.ERC20 && currencyId === CurrencyIds.ETH)
    return undefined;

  if (item.amount < 0n) return undefined;

  return { currency: currencyId, amount: item.amount };
}

function extractItemsFromTuples(
  chainId: number,
  tuples: readonly (OfferTuple | ConsiderationTuple)[],
): { nfts: DomainAssetId[]; payments: SupportedPayment[] } {
  const nfts: DomainAssetId[] = [];
  const payments: SupportedPayment[] = [];

  for (const tuple of tuples) {
    const item = parseTupleToItem(tuple);
    const nft = getSupportedNFTFromItem(chainId, item);
    if (nft) {
      nfts.push(nft);
      continue;
    }
    const payment = getSupportedPaymentFromItem(item);
    if (payment) {
      payments.push(payment);
    }
  }

  return { nfts, payments };
}

function consolidateNFTs(
  nfts: DomainAssetId[],
): DomainAssetId | undefined {
  if (nfts.length !== 1) return undefined;
  return nfts[0];
}

function consolidatePayments(
  payments: SupportedPayment[],
): SupportedPayment | undefined {
  const currencies = [...new Set(payments.map((p) => p.currency))];
  if (currencies.length !== 1) return undefined;

  const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0n);
  return { currency: currencies[0]!, amount: totalAmount };
}

/**
 * Parse a Seaport OrderFulfilled event into a SupportedSale, if the order
 * represents a single supported ENS NFT sale with a single supported currency.
 */
export function getSupportedSaleFromOrderFulfilledEvent(
  chainId: number,
  orderHash: string,
  offerer: string,
  recipient: string,
  offer: readonly OfferTuple[],
  consideration: readonly ConsiderationTuple[],
): SupportedSale | undefined {
  const offerExtractions = extractItemsFromTuples(chainId, offer);
  const considerationExtractions = extractItemsFromTuples(
    chainId,
    consideration,
  );

  const offerNFT = consolidateNFTs(offerExtractions.nfts);
  const considerationNFT = consolidateNFTs(considerationExtractions.nfts);
  const offerPayment = consolidatePayments(offerExtractions.payments);
  const considerationPayment = consolidatePayments(
    considerationExtractions.payments,
  );

  // Standard listing: offerer sells NFT, recipient pays
  if (offerNFT && !considerationNFT && !offerPayment && considerationPayment) {
    return {
      orderHash,
      nft: offerNFT,
      payment: considerationPayment,
      seller: offerer,
      buyer: recipient,
    };
  }

  // Standard offer: offerer pays, recipient sells NFT
  if (!offerNFT && considerationNFT && offerPayment && !considerationPayment) {
    return {
      orderHash,
      nft: considerationNFT,
      payment: offerPayment,
      seller: recipient,
      buyer: offerer,
    };
  }

  // Unsupported sale pattern
  return undefined;
}
