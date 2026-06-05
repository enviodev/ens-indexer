/**
 * Workaround for an envio bug (present in 3.0.0-rc.0 and 3.1.0-rc.1):
 *
 * For entity names that start with a lowercase letter (e.g. `subgraph_domain`,
 * required for ENSDb naming parity), the runtime handler context is keyed by
 * the raw schema entity name (`context.subgraph_domain`), but codegen emits
 * capitalized keys in `.envio/types.d.ts` (`context.Subgraph_domain`), so
 * type-correct code crashes at runtime with:
 *
 *   Invalid context access by 'Subgraph_domain' property.
 *
 * This script rewrites the generated `Entities` map keys (and their
 * references) back to the raw schema names so the types match the runtime.
 *
 * Run automatically via `pnpm codegen`. NOTE: `envio dev` regenerates types on
 * startup, so `pnpm codegen` (or this script) must be re-run afterwards for
 * `tsc` to pass — runtime behavior is unaffected either way.
 */
import { readFileSync, writeFileSync } from "node:fs";

const TYPES_PATH = new URL("../.envio/types.d.ts", import.meta.url);

const schema = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");
const entityNames = [...schema.matchAll(/^type\s+(\w+)/gm)].map((m) => m[1]);

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);
const renames = entityNames
	.filter((name) => capitalize(name) !== name)
	.map((name) => [capitalize(name), name]);

let src = readFileSync(TYPES_PATH, "utf8");

if (src.includes("// patched by scripts/patch-generated-types.mjs")) {
	console.log("types.d.ts already patched, skipping");
	process.exit(0);
}

// 1. rename keys inside the `type Entities = { ... }` block ONLY — capitalized
// entity names can collide with contract names elsewhere in the file (e.g. the
// `resolver` entity vs the `Resolver` contract)
const blockStart = src.indexOf("type Entities = {");
if (blockStart === -1) throw new Error("`type Entities = {` block not found");

let depth = 0;
let blockEnd = -1;
for (let i = src.indexOf("{", blockStart); i < src.length; i++) {
	if (src[i] === "{") depth++;
	else if (src[i] === "}") {
		depth--;
		if (depth === 0) {
			blockEnd = i;
			break;
		}
	}
}
if (blockEnd === -1) throw new Error("unbalanced braces in Entities block");

let block = src.slice(blockStart, blockEnd);
for (const [cap, raw] of renames) {
	block = block.replaceAll(`"${cap}": {`, `"${raw}": {`);
}
src = src.slice(0, blockStart) + block + src.slice(blockEnd);

// 2. fix all `Entities["X"]` references (safe globally — only entity lookups)
for (const [cap, raw] of renames) {
	src = src.replaceAll(`Entities["${cap}"]`, `Entities["${raw}"]`);
}

src += "\n// patched by scripts/patch-generated-types.mjs\n";

writeFileSync(TYPES_PATH, src);
console.log(`patched ${renames.length} entity names in .envio/types.d.ts`);
