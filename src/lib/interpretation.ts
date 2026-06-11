import { ens_normalize } from "@adraffy/ens-normalize";
import { keccak256, stringToBytes } from "viem";
import { S, createEffect } from "envio";

// NOTE: duplicated from helpers.ts to avoid a circular import
// (helpers.ts imports interpretation.ts).
function encodeLabelHash(labelHash: string): string {
  return `[${labelHash.slice(2)}]`;
}

/**
 * When true, the indexer produces a legacy-ENS-Subgraph-compatible dataset
 * (matching the reference ENSIndexer's SUBGRAPH_COMPAT=true mode):
 * - event/resolver IDs without chainId prefixes, registration IDs = labelHash
 * - Subgraph Interpreted labels (literal labels kept iff subgraph-indexable)
 * - no addr.reverse subname healing
 * - root domain name is null
 *
 * Default (false) produces the chain-scoped Interpreted (ENSIP-15) dataset.
 */
export const IS_SUBGRAPH_COMPAT = process.env.SUBGRAPH_COMPAT === "true";

/**
 * Subgraph "indexable label" check (reference `isLabelSubgraphIndexable`):
 * null labels and labels containing the null byte, '.', '[' or ']' are not
 * indexable.
 */
const UNINDEXABLE_LABEL_CHARACTER_CODES = new Set(
  ["\0", ".", "[", "]"].map((c) => c.charCodeAt(0)),
);

export function isLabelSubgraphIndexable(label: string | null): label is string {
  if (label === null) return false;
  for (let i = 0; i < label.length; i++) {
    if (UNINDEXABLE_LABEL_CHARACTER_CODES.has(label.charCodeAt(i))) return false;
  }
  return true;
}

// ─── Label Interpretation (ported from ensnode enssdk) ─────────────────────
// Mirrors `SUBGRAPH_COMPAT=false` ("Interpreted Label / Name") semantics of the
// ENSIndexer reference implementation so indexed name/label_name values match
// the ENSDb reference byte-for-byte.

/**
 * keccak256 of the literal label bytes.
 * Same as enssdk `labelhashLiteralLabel` — viem/ens#labelhash WITHOUT the
 * special-case handling of Encoded LabelHashes.
 */
export function labelhashLiteralLabel(label: string): string {
  return keccak256(stringToBytes(label));
}

/**
 * ENSIP-15 normalized-label check (enssdk `isNormalizedLabel`).
 */
export function isNormalizedLabel(label: string): boolean {
  if (label === "") return false;
  if (label.includes(".")) return false;
  try {
    return label === ens_normalize(label);
  } catch {
    return false;
  }
}

/**
 * Literal Label → Interpreted Label (enssdk `literalLabelToInterpretedLabel`):
 * the label itself when normalized, otherwise the Encoded LabelHash of its
 * literal bytes.
 */
export function literalLabelToInterpretedLabel(label: string): string {
  if (isNormalizedLabel(label)) return label;
  return encodeLabelHash(labelhashLiteralLabel(label));
}

/**
 * Interpreted child label + parent Interpreted Name → Interpreted Name
 * (enssdk `constructSubInterpretedName`). The ENS Root Name is '' so a TLD's
 * name is just its label.
 */
export function constructSubInterpretedName(
  label: string,
  parentName: string | undefined,
): string {
  if (parentName === undefined || parentName === "") return label;
  return `${label}.${parentName}`;
}

/**
 * Given a labelHash and the (possibly null) healed Literal Label, produce the
 * Interpreted Label exactly like the reference Registry/Registrar handlers do.
 */
export function interpretHealedLabel(
  labelHash: string,
  healedLabel: string | null,
): string {
  return healedLabel !== null
    ? literalLabelToInterpretedLabel(healedLabel)
    : encodeLabelHash(labelHash);
}

/**
 * Strictly decode a DNS-Encoded Name (hex packet) into its Literal Labels
 * (enssdk `decodeDNSEncodedName`): throws on empty packets, overflow, or
 * trailing junk — the reference treats any such malformed packet as
 * undecodable (null name).
 */
export function strictDecodeDNSEncodedName(packet: string): string[] {
  const hex = packet.startsWith("0x") ? packet.slice(2) : packet;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0) throw new Error("Packet is empty.");

  const segments: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const len = bytes[offset]!;
    if (len === 0) break;
    segments.push(bytes.subarray(offset + 1, offset + len + 1).toString("utf8"));
    offset += len + 1;
  }

  if (offset >= bytes.length) throw new Error("Overflow, offset >= bytes.length");
  if (offset !== bytes.length - 1) throw new Error("Junk at end of name");

  return segments;
}

/**
 * Decode the NameWrapper's emitted DNS-Encoded Name into an Interpreted Name
 * and its first Interpreted Label (reference
 * `decodeInterpretedNameWrapperName`). Malformed packets yield nulls, as the
 * subgraph indexing logic expects.
 *
 * In SUBGRAPH_COMPAT mode the subgraph variant is used instead (reference
 * `subgraph_decodeDNSEncodedLiteralName`): labels are kept literal, and the
 * whole name is null if malformed OR if any label is not subgraph-indexable.
 */
export function decodeInterpretedNameWrapperName(
  packet: string,
): { label: string; name: string } | { label: null; name: null } {
  try {
    const literalLabels = strictDecodeDNSEncodedName(packet);

    if (literalLabels.length === 0) {
      throw new Error(
        `Invariant: NameWrapper emitted ${packet} that decoded to root node (empty string).`,
      );
    }

    if (IS_SUBGRAPH_COMPAT) {
      if (!literalLabels.every((l) => isLabelSubgraphIndexable(l))) {
        throw new Error("Some decoded literal labels were not subgraph-indexable.");
      }
      return {
        label: literalLabels[0]!,
        name: literalLabels.join("."),
      };
    }

    return {
      label: literalLabelToInterpretedLabel(literalLabels[0]!),
      name: literalLabels.map(literalLabelToInterpretedLabel).join("."),
    };
  } catch {
    return { label: null, name: null };
  }
}

/**
 * Attempt to heal an addr.reverse subname label from a candidate address
 * (reference `maybeHealLabelByAddrReverseSubname`): the label of
 * `{address}.addr.reverse` is the lowercase hex address without the 0x prefix.
 */
export function maybeHealLabelByAddrReverseSubname(
  labelHash: string,
  address: string,
): string | null {
  const maybeLabel = address.toLowerCase().slice(2);
  if (labelhashLiteralLabel(maybeLabel) === labelHash) return maybeLabel;
  return null;
}

// ─── ENSRainbow Healing (Effect API) ────────────────────────────────────────

const ENSRAINBOW_URL = process.env.ENSRAINBOW_URL ?? "https://api.ensrainbow.io";
const LABEL_SET_ID = process.env.LABEL_SET_ID ?? "subgraph";
const LABEL_SET_VERSION = process.env.LABEL_SET_VERSION ?? "0";

type HealResponse =
  | { status: "success"; label: string }
  | { status: "error"; error: string; errorCode: number };

const RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

/**
 * Heal a labelHash to its original Literal Label via ENSRainbow, pinned to the
 * subgraph/0 label set like the reference ENSIndexer. Returns null when no
 * label is known (404). Retries transient failures, then throws (matching the
 * reference's fail-fast behavior — a silent fallback would corrupt parity).
 */
export const healLabelByLabelHash = createEffect(
  {
    name: "healLabelByLabelHash",
    input: S.string,
    output: S.union([S.string, null]),
    cache: true,
    rateLimit: false,
  },
  async ({ input: labelHash }) => {
    const url =
      `${ENSRAINBOW_URL}/v1/heal/${labelHash}` +
      `?label_set_id=${LABEL_SET_ID}&label_set_version=${LABEL_SET_VERSION}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const response = await fetch(url);
        const body = (await response.json()) as HealResponse;

        if (body.status === "success") return body.label;
        if (body.errorCode === 404) return null;
        if (body.errorCode === 400) {
          throw new Error(
            `ENSRainbow heal bad request for "${labelHash}": ${body.error}`,
          );
        }
        // 500-class: transient, retry
        lastError = new Error(
          `ENSRainbow heal server error for "${labelHash}": ${body.error}`,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("bad request")) {
          throw error;
        }
        lastError = error;
      }
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    throw new Error(
      `ENSRainbow unavailable at '${ENSRAINBOW_URL}' after ${RETRIES + 1} attempts: ${lastError}`,
    );
  },
);
