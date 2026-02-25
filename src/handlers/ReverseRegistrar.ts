import { StandaloneReverseRegistrar } from "generated";

import {
  upsertReverseNameRecord,
  evmChainIdToCoinType,
  DEFAULT_EVM_COIN_TYPE,
} from "../lib/protocol-acceleration";

// ─── StandaloneReverseRegistrar.NameForAddrChanged ──────────────────────────
// PA-only: indexes ENSIP-19 reverse name records per address and coinType.

StandaloneReverseRegistrar.NameForAddrChanged.handler(async ({ event, context }) => {
  const { addr, name } = event.params;

  // ENS Root Chain → DEFAULT_EVM_COIN_TYPE, others → chain-specific
  const coinType = event.chainId === 1
    ? DEFAULT_EVM_COIN_TYPE
    : evmChainIdToCoinType(event.chainId);

  upsertReverseNameRecord(context, addr, coinType, name);
});
