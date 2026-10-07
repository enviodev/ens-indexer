import { indexer } from "envio";

import {
  upsertReverseNameRecord,
  evmChainIdToCoinType,
  DEFAULT_EVM_COIN_TYPE,
} from "../lib/protocol-acceleration";

// ─── StandaloneReverseRegistrar.NameForAddrChanged ──────────────────────────
// PA-only: indexes ENSIP-19 reverse name records per address and coinType.

indexer.onEvent(
  { contract: "StandaloneReverseRegistrar", event: "NameForAddrChanged" },
  async ({ event, context }) => {
  const { addr, name } = event.params;

  // ENS Root Chain → DEFAULT_EVM_COIN_TYPE, others → chain-specific
  const coinType = event.chainId === 1
    ? DEFAULT_EVM_COIN_TYPE
    : evmChainIdToCoinType(event.chainId);

  upsertReverseNameRecord(context, addr, coinType, name);
  },
);

// ─── ReverseRegistrar.ReverseClaimed ────────────────────────────────────────
// Records which address a legacy reverse node belongs to. Emitted before the
// resolver's NameChanged in the same call, so Resolver.NameChanged can use it
// as the exact address (contract wallets, relayed calls).

indexer.onEvent(
  { contract: "ReverseRegistrar", event: "ReverseClaimed" },
  async ({ event, context }) => {
  context.Reverse_claim.set({
    id: event.params.node,
    addr: event.params.addr.toLowerCase(),
  });
  },
);
