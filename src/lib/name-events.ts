import type { handlerContext } from "./helpers";

// Appends a row to name_event, the change log for kinds that have no event
// table of their own. Ids are unique per log; `seq` separates several rows
// written for one log (a record shared by several names).

export interface NameEventInput {
  kind:
    | "REGISTRATION"
    | "RESERVATION"
    | "UNREGISTRATION"
    | "EXPIRY"
    | "RESOLVER"
    | "SUBREGISTRY"
    | "RECORD"
    | "ALIAS"
    | "PRIMARY_NAME";
  protocol: "v1" | "v2";
  node?: string | undefined;
  name?: string | undefined;
  address?: string | undefined;
  detail?: Record<string, unknown>;
  seq?: number;
}

export function emitNameEvent(
  context: handlerContext,
  event: { chainId: number; block: { number: number; timestamp: number }; logIndex: number; transaction: { hash: string } },
  input: NameEventInput,
): void {
  const base = `${event.chainId}-${event.block.number}-${event.logIndex}`;
  context.Name_event.set({
    id: input.seq === undefined ? base : `${base}-${input.seq}`,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
    kind: input.kind,
    protocol: input.protocol,
    node: input.node,
    name: input.name,
    address: input.address?.toLowerCase(),
    detail: input.detail
      ? JSON.stringify(input.detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
      : undefined,
  });
}
