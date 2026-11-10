#!/usr/bin/env node
// Writes config.local.yaml: config.yaml narrowed to the given chains and to the
// ENSv2 contracts, for syncing over RPC without a HyperSync token.
//
//   node scripts/local-config.mjs 11155111 [1 ...]
//   ENVIO_CONFIG=config.local.yaml ENS_RPC_URL_11155111=... pnpm dev
import { readFileSync, writeFileSync } from "node:fs";

const wanted = new Set(process.argv.slice(2));
if (wanted.size === 0) {
  console.error("usage: local-config.mjs <chainId> [chainId ...]");
  process.exit(1);
}

const src = readFileSync("config.yaml", "utf8");
const marker = "\nchains:\n";
const at = src.indexOf(marker);
const head = src.slice(0, at + marker.length);
const rest = src.slice(at + marker.length);
const tailAt = rest.indexOf("\naddress_format:");
const body = rest.slice(0, tailAt);
const tail = rest.slice(tailAt);

const keepContract = (block) => /^\s+- name: (V2\w+|Resolver)\s*$/m.test(block.split("\n")[0]);

const chains = body.split(/^(?=  - id: )/m).filter((b) => b.startsWith("  - id: "));
const out = [];
for (const chain of chains) {
  const id = chain.match(/- id: (\d+)/)[1];
  if (!wanted.has(id)) continue;
  const at2 = chain.indexOf("    contracts:\n") + "    contracts:\n".length;
  const contracts = chain.slice(at2).split(/^(?=      - name: )/m).filter(keepContract);
  const kept = contracts.map((c) =>
    // Resolver is only ever filled in dynamically here.
    /- name: Resolver/.test(c) ? "      - name: Resolver\n" : c,
  );
  out.push(chain.slice(0, at2) + kept.join(""));
}
writeFileSync("config.local.yaml", head + out.join("") + tail);
console.log(`config.local.yaml: chains ${[...wanted].join(", ")}`);
