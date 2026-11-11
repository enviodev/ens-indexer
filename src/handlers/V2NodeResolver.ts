import { indexer } from "envio";
import { makeV2RegistryId } from "../lib/v2-helpers";
import { hasNullByte } from "../lib/helpers";
import { ETH_COIN_TYPE } from "../lib/protocol-acceleration";

// Node-keyed record events, matched on any address (see config.yaml). Rows are
// keyed by resolver and node; the API reads them only for a resolver that a
// proven ENSv2 domain points at, so a contract nobody links to has no effect.

function recordId(chainId: number, resolver: string, node: string): string {
  return `${makeV2RegistryId(chainId, resolver)}-${node}`;
}

indexer.onEvent({ contract: "V2NodeResolver", event: "AddrChanged", wildcard: true }, async ({ event, context }) => {
  const { node, a } = event.params;
  const resolver = event.srcAddress.toLowerCase();
  const id = `${recordId(event.chainId, resolver, node)}-${ETH_COIN_TYPE}`;
  const value = a.toLowerCase();
  if (value === "0x0000000000000000000000000000000000000000") {
    context.V2_node_address.deleteUnsafe(id);
    return;
  }
  context.V2_node_address.set({ id, resolver, node, coinType: BigInt(ETH_COIN_TYPE), value });
});

indexer.onEvent({ contract: "V2NodeResolver", event: "AddressChanged", wildcard: true }, async ({ event, context }) => {
  const { node, coinType, newAddress } = event.params;
  const resolver = event.srcAddress.toLowerCase();
  const id = `${recordId(event.chainId, resolver, node)}-${coinType}`;
  if (newAddress === "0x") {
    context.V2_node_address.deleteUnsafe(id);
    return;
  }
  context.V2_node_address.set({ id, resolver, node, coinType, value: newAddress.toLowerCase() });
});

indexer.onEvent({ contract: "V2NodeResolver", event: "TextChanged", wildcard: true }, async ({ event, context }) => {
  const { node, key, value } = event.params;
  if (hasNullByte(key)) return;
  const resolver = event.srcAddress.toLowerCase();
  const id = `${recordId(event.chainId, resolver, node)}-${key}`;
  if (value === "") {
    context.V2_node_text.deleteUnsafe(id);
    return;
  }
  context.V2_node_text.set({ id, resolver, node, key, value });
});

async function upsertNodeRecord(
  context: Parameters<Parameters<typeof indexer.onEvent>[1]>[0]["context"],
  chainId: number,
  resolverAddress: string,
  node: string,
  patch: { contenthash?: string | undefined; name?: string | undefined },
) {
  const resolver = resolverAddress.toLowerCase();
  const id = recordId(chainId, resolver, node);
  const existing = await context.V2_node_record.get(id);
  context.V2_node_record.set({
    id,
    resolver,
    node,
    contenthash: existing?.contenthash,
    name: existing?.name,
    ...patch,
  });
}

indexer.onEvent({ contract: "V2NodeResolver", event: "ContenthashChanged", wildcard: true }, async ({ event, context }) => {
  const { node, hash } = event.params;
  await upsertNodeRecord(context, event.chainId, event.srcAddress, node, { contenthash: hash === "0x" ? undefined : hash });
});

indexer.onEvent({ contract: "V2NodeResolver", event: "NameChanged", wildcard: true }, async ({ event, context }) => {
  const { node, name } = event.params;
  if (hasNullByte(name)) return;
  await upsertNodeRecord(context, event.chainId, event.srcAddress, node, { name: name === "" ? undefined : name });
});
